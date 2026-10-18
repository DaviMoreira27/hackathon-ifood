import type { Message, NewMessage } from '../src/messages/messages.service.js';
import type { SavedRestriction } from '../src/dietary/dietary.check.js';
import type { NewRestriction } from '../src/dietary/dietary.service.js';
import { GroupOrderError } from '../src/group-order/group-order.errors.js';
import {
  normalizeName,
  type AssignPayerInput,
  type OrderView,
  type SyncCartInput,
} from '../src/group-order/group-order.service.js';
import { formatBRL, toCents } from '../src/group-order/money.js';
import { splitCart } from '../src/group-order/split.js';
import type { NewTurnTrace } from '../src/agent/turn-traces.service.js';

// Substitutos em memória dos serviços que falam com o Postgres. Seguem as regras do serviço real
// (um pagador por item, cada pessoa paga um carrinho só, edição só com o pedido em montagem).

export class MemoryMessages {
  rows: Message[] = [];
  add = async (row: NewMessage) => {
    this.rows.push({
      id: this.rows.length + 1,
      userId: null,
      payload: null,
      createdAt: new Date(),
      ...row,
    } as Message);
  };
  addMany = async (rows: NewMessage[]) => {
    for (const row of rows) await this.add(row);
  };
  recent = async (chatId: number, limit: number) =>
    this.rows.filter((r) => r.chatId === chatId).slice(-limit);
  clearChat = async (chatId: number) => {
    this.rows = this.rows.filter((r) => r.chatId !== chatId);
  };
}

export class MemoryDiet {
  saved: SavedRestriction[] = [];
  list = async (_userId: number) => [...this.saved];
  save = async (
    _userId: number,
    person: { key: string; name: string | null },
    entries: NewRestriction[],
  ) => {
    for (const e of entries) {
      this.saved = this.saved.filter(
        (s) => !(s.personKey === person.key && s.kind === e.kind),
      );
      this.saved.push({ ...e, personKey: person.key, personName: person.name });
    }
  };
  remove = async (_userId: number, personKey: string, kinds?: string[]) => {
    const before = this.saved.length;
    this.saved = this.saved.filter(
      (s) =>
        s.personKey !== personKey ||
        (kinds?.length ? !kinds.includes(s.kind) : false),
    );
    return before - this.saved.length;
  };
}

export class MemoryTraces {
  turns: NewTurnTrace[] = [];
  record = async (trace: NewTurnTrace) => {
    this.turns.push(trace);
  };
}

interface Item {
  itemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  payerId: number | null;
}
interface Cart {
  ifoodCartId: string;
  restaurantName: string;
  subtotal: number;
  total: number;
  status: 'pending' | 'confirmed' | 'paid';
  items: Item[];
}
interface Payment {
  participantId: number;
  cart: string;
  amountCents: number;
  status: 'pending' | 'paid' | 'void';
  url: string;
}
interface Order {
  id: number;
  status: 'collecting' | 'paying' | 'paid' | 'cancelled' | 'completed';
  participants: Array<{ id: number; name: string }>;
  carts: Cart[];
  payments: Payment[];
}

export class MemoryGroupOrders {
  orders: Order[] = [];
  private seq = 0;

  active() {
    return this.orders.find(
      (o) => o.status === 'collecting' || o.status === 'paying',
    );
  }

  private ensureCollecting(create: boolean): Order {
    let order = this.active();
    if (!order && create) {
      order = {
        id: ++this.seq,
        status: 'collecting',
        participants: [],
        carts: [],
        payments: [],
      };
      this.orders.push(order);
    }
    if (!order) throw new GroupOrderError('Não há pedido em andamento.');
    if (order.status !== 'collecting') {
      throw new GroupOrderError(
        'O pedido já foi confirmado e está em pagamento: para alterar, use group_reopen_order (só se ninguém pagou).',
      );
    }
    return order;
  }

  private nameOf(order: Order, id: number | null) {
    return order.participants.find((p) => p.id === id)?.name ?? null;
  }

  async hasPaidOrder(_userId: number) {
    return this.orders.some((o) => o.status === 'paid');
  }

  async openIfoodCartIds(_userId: number) {
    return this.orders
      .filter((o) => o.status === 'collecting' || o.status === 'paying')
      .flatMap((o) => o.carts.map((c) => c.ifoodCartId));
  }

  async getOrderView(_userId: number): Promise<OrderView> {
    const awaiting = this.orders
      .filter((o) => o.status === 'paid')
      .map((o) => ({
        order_id: o.id,
        carts: o.carts.map((c) => ({
          ifood_cart_id: c.ifoodCartId,
          restaurant: c.restaurantName,
        })),
      }));
    const order = this.active();
    if (!order) {
      return {
        order: null,
        hint: 'Não há pedido em andamento. Ele é criado ao cadastrar participantes ou carrinhos.',
        awaiting_finalization: awaiting,
      };
    }
    const problems: string[] = [];
    const preview: Array<Record<string, string>> = [];
    for (const cart of order.carts) {
      if (order.status !== 'collecting') continue;
      try {
        for (const a of splitCart(
          cart.items.map((i) => ({
            name: i.name,
            priceCents: toCents(i.unitPrice),
            quantity: i.quantity,
            payerId: i.payerId,
          })),
          toCents(cart.subtotal),
          toCents(cart.total),
        )) {
          preview.push({
            cart: cart.restaurantName,
            participant: this.nameOf(order, a.payerId) ?? String(a.payerId),
            items: formatBRL(a.itemsCents),
            fees_share: formatBRL(a.feesCents),
            total: formatBRL(a.amountCents),
          });
        }
      } catch (err) {
        if (!(err instanceof GroupOrderError)) throw err;
        problems.push(`${cart.restaurantName}: ${err.message}`);
      }
    }
    if (order.participants.length === 0 && order.carts.length > 0) {
      problems.push(
        'Há carrinhos mas nenhum participante: use group_add_participant.',
      );
    }
    return {
      order: { id: order.id, status: order.status },
      participants: order.participants.map((p) => p.name),
      carts: order.carts.map((c) => ({
        ifood_cart_id: c.ifoodCartId,
        restaurant: c.restaurantName,
        status: c.status,
        subtotal: formatBRL(toCents(c.subtotal)),
        total: formatBRL(toCents(c.total)),
        items: c.items.map((i) => ({
          item_id: i.itemId,
          name: i.name,
          unit_price: formatBRL(toCents(i.unitPrice)),
          quantity: i.quantity,
          payer: this.nameOf(order, i.payerId),
        })),
        payers: [
          ...new Set(
            c.items
              .map((i) => this.nameOf(order, i.payerId))
              .filter((n): n is string => !!n),
          ),
        ],
      })),
      ...(preview.length ? { amounts_preview: preview } : {}),
      payments: order.payments
        .filter((p) => p.status !== 'void')
        .map((p) => ({
          participant: this.nameOf(order, p.participantId) ?? '',
          restaurant: p.cart,
          amount: formatBRL(p.amountCents),
          status: p.status,
        })),
      problems,
      awaiting_finalization: awaiting,
    };
  }

  async addParticipant(_userId: number, rawName: string) {
    const order = this.ensureCollecting(true);
    const name = rawName.replace(/\s+/g, ' ').trim();
    const existing = order.participants.find(
      (p) => normalizeName(p.name) === normalizeName(name),
    );
    if (!existing) order.participants.push({ id: ++this.seq, name });
    return {
      created: !existing,
      participant: existing?.name ?? name,
      participants: order.participants.map((p) => p.name),
    };
  }

  async syncCart(_userId: number, input: SyncCartInput) {
    const order = this.ensureCollecting(true);
    const current = order.carts.find(
      (c) => c.ifoodCartId === input.ifoodCartId,
    );
    if (input.items.length === 0) {
      order.carts = order.carts.filter((c) => c !== current);
      return { removed: !!current, ifood_cart_id: input.ifoodCartId };
    }
    const items = input.items.map((i) => ({
      itemId: i.itemId,
      name: i.name,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
      payerId:
        current?.items.find((x) => x.itemId === i.itemId)?.payerId ?? null,
    }));
    const cart: Cart = {
      ifoodCartId: input.ifoodCartId,
      restaurantName: input.restaurantName,
      subtotal: input.subtotal,
      total: input.total,
      status: 'pending',
      items,
    };
    order.carts = current
      ? order.carts.map((c) => (c === current ? cart : c))
      : [...order.carts, cart];
    return this.summary(order, cart);
  }

  async assignPayer(_userId: number, input: AssignPayerInput) {
    const order = this.ensureCollecting(false);
    const cart = order.carts.find((c) => c.ifoodCartId === input.ifoodCartId);
    if (!cart)
      throw new GroupOrderError(
        `Carrinho ${input.ifoodCartId} não registrado.`,
      );
    const item = cart.items.find((i) => i.itemId === input.itemId);
    if (!item) {
      throw new GroupOrderError(
        `Item ${input.itemId} não existe no carrinho ${cart.restaurantName}. Itens: ${cart.items.map((i) => `${i.itemId} (${i.name})`).join(', ')}.`,
      );
    }
    const person = order.participants.find(
      (p) => normalizeName(p.name) === normalizeName(input.participantName),
    );
    if (!person) {
      throw new GroupOrderError(
        `Participante "${input.participantName}" não cadastrado. Cadastrados: ${order.participants.map((p) => p.name).join(', ') || 'nenhum'}.`,
      );
    }
    const other = order.carts.find(
      (c) => c !== cart && c.items.some((i) => i.payerId === person.id),
    );
    if (other) {
      throw new GroupOrderError(
        `${person.name} já paga o carrinho ${other.restaurantName}. Cada pessoa paga em um carrinho só: indique outra pessoa para este item.`,
      );
    }
    item.payerId = person.id;
    return this.summary(order, cart);
  }

  async confirmOrder(_userId: number) {
    const order = this.active();
    if (!order) throw new GroupOrderError('Não há pedido em andamento.');
    const alreadyConfirmed = order.status === 'paying';
    if (!alreadyConfirmed) {
      const view = await this.getOrderView(0);
      if (view.problems?.length)
        throw new GroupOrderError(view.problems.join(' '));
      for (const cart of order.carts) {
        for (const a of splitCart(
          cart.items.map((i) => ({
            name: i.name,
            priceCents: toCents(i.unitPrice),
            quantity: i.quantity,
            payerId: i.payerId,
          })),
          toCents(cart.subtotal),
          toCents(cart.total),
        )) {
          order.payments.push({
            participantId: a.payerId,
            cart: cart.restaurantName,
            amountCents: a.amountCents,
            status: 'pending',
            url: `https://pagamentos.example/p/${order.id}-${a.payerId}`,
          });
        }
        cart.status = 'confirmed';
      }
      order.status = 'paying';
    }
    const pending = order.payments.filter((p) => p.status === 'pending');
    return {
      alreadyConfirmed,
      payments: order.payments
        .filter((p) => p.status !== 'void')
        .map((p) => ({
          participant: this.nameOf(order, p.participantId) ?? '',
          restaurant: p.cart,
          amount: formatBRL(p.amountCents),
          status: p.status,
        })),
      links: pending.map((p) => ({
        participant: this.nameOf(order, p.participantId) ?? '',
        restaurant: p.cart,
        amount: formatBRL(p.amountCents),
        url: p.url,
      })),
      failed: [] as string[],
    };
  }

  async reopenOrder(_userId: number) {
    return this.release('reopen');
  }

  async cancelOrder(_userId: number) {
    return this.release('cancel');
  }

  private release(mode: 'reopen' | 'cancel') {
    const order = this.active();
    if (!order) throw new GroupOrderError('Não há pedido em andamento.');
    if (order.payments.some((p) => p.status === 'paid')) {
      throw new GroupOrderError(
        'Alguém já pagou: não é possível alterar nem cancelar o pedido.',
      );
    }
    for (const p of order.payments) p.status = 'void';
    for (const c of order.carts) c.status = 'pending';
    order.status = mode === 'reopen' ? 'collecting' : 'cancelled';
    return { order_id: order.id, status: order.status };
  }

  async markFinalized(_userId: number, orderId?: number) {
    const paid = this.orders.filter((o) => o.status === 'paid');
    const order = orderId ? paid.find((o) => o.id === orderId) : paid[0];
    if (!order)
      throw new GroupOrderError('Não há pedido pago aguardando finalização.');
    order.status = 'completed';
    return { order_id: order.id, status: 'completed' };
  }

  // Cenários que começam com todos os pagamentos feitos.
  markAllPaid() {
    const order = this.active();
    if (!order) throw new Error('sem pedido ativo');
    for (const p of order.payments)
      if (p.status === 'pending') p.status = 'paid';
    for (const c of order.carts) c.status = 'paid';
    order.status = 'paid';
  }

  private summary(order: Order, cart: Cart) {
    return {
      ifood_cart_id: cart.ifoodCartId,
      restaurant: cart.restaurantName,
      subtotal: formatBRL(toCents(cart.subtotal)),
      total: formatBRL(toCents(cart.total)),
      items: cart.items.map((i) => ({
        item_id: i.itemId,
        name: i.name,
        unit_price: formatBRL(toCents(i.unitPrice)),
        quantity: i.quantity,
        payer: this.nameOf(order, i.payerId),
      })),
      warnings: [] as string[],
    };
  }
}
