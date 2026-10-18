import { Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { pgErrorCode } from '../db/errors.js';
import {
  cartItems,
  cartPayers,
  carts,
  orders,
  participants,
  payments,
} from '../db/schema.js';
import type { Tx } from '../db/types.js';
import { PaymentsService } from '../payments/payments.service.js';
import { GroupOrderError } from './group-order.errors.js';
import { formatBRL, fromCents, toCents } from './money.js';
import { splitCart, type PayerAmount } from './split.js';

type OrderRow = typeof orders.$inferSelect;
type CartRow = typeof carts.$inferSelect;

export interface SyncCartInput {
  ifoodCartId: string;
  restaurantName: string;
  subtotal: number;
  total: number;
  items: Array<{
    itemId: string;
    name: string;
    unitPrice: number;
    quantity: number;
  }>;
}

export interface AssignPayerInput {
  ifoodCartId: string;
  itemId: string;
  participantName: string;
}

export interface CartSummary {
  ifood_cart_id: string;
  restaurant: string;
  subtotal: string;
  total: string;
  items: Array<{
    item_id: string;
    name: string;
    unit_price: string;
    quantity: number;
    payer: string | null;
  }>;
  warnings: string[];
}

export type SyncCartResult =
  CartSummary | { removed: boolean; ifood_cart_id: string };

export interface OrderView {
  order: { id: number; status: string } | null;
  hint?: string;
  participants?: string[];
  carts?: Array<
    Omit<CartSummary, 'warnings'> & { status: string; payers: string[] }
  >;
  amounts_preview?: Array<Record<string, string>>;
  payments?: Array<{
    participant: string;
    restaurant: string;
    amount: string;
    status: string;
  }>;
  problems?: string[];
  awaiting_finalization: Array<{
    order_id: number;
    carts: Array<{ ifood_cart_id: string; restaurant: string }>;
  }>;
}

export interface PaymentLink {
  participant: string;
  restaurant: string;
  amount: string;
  url: string;
}

const PG_FK_VIOLATION = '23503';
const PG_UNIQUE_VIOLATION = '23505';

export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanName(name: unknown): string {
  const cleaned =
    typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  if (!cleaned || cleaned.length > 60) {
    throw new GroupOrderError('Nome inválido: use de 1 a 60 caracteres.');
  }
  return cleaned;
}

const cartLabel = (cart: Pick<CartRow, 'restaurantName' | 'ifoodCartId'>) =>
  cart.restaurantName ?? cart.ifoodCartId;

// Regras do pedido em grupo:
//  - cada restaurante é um carrinho; cada item tem exatamente um pagador;
//  - cada pessoa paga em NO MÁXIMO UM carrinho (garantido também pelo banco);
//  - o pedido só é cobrado depois de confirmado; reabrir só é possível se ninguém pagou.
// Toda escrita roda numa transação que trava a linha do pedido (FOR UPDATE): editar o pedido e
// aplicar um pagamento recebido pelo RabbitMQ nunca se atropelam.
@Injectable()
export class GroupOrderService {
  private readonly logger = new Logger(GroupOrderService.name);

  constructor(
    private readonly database: DbService,
    private readonly paymentsService: PaymentsService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ───────────────────────── consulta ─────────────────────────

  async hasPaidOrder(userId: number): Promise<boolean> {
    const rows = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.ownerUserId, userId), eq(orders.status, 'paid')))
      .limit(1);
    return rows.length > 0;
  }

  // ids de carrinho do iFood que ainda não foram pagos (usado para barrar o checkout).
  async openIfoodCartIds(userId: number): Promise<string[]> {
    const rows = await this.db
      .select({ id: carts.ifoodCartId })
      .from(carts)
      .innerJoin(orders, eq(orders.id, carts.orderId))
      .where(
        and(
          eq(orders.ownerUserId, userId),
          inArray(orders.status, ['collecting', 'paying']),
        ),
      );
    return rows.map((r) => r.id);
  }

  async getOrderView(userId: number): Promise<OrderView> {
    const [active] = await this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.ownerUserId, userId),
          inArray(orders.status, ['collecting', 'paying']),
        ),
      )
      .orderBy(desc(orders.id))
      .limit(1);

    // Só o último pedido pago: pedidos antigos não voltam à conversa (um pedido novo descarta os
    // anteriores; ver requireCollecting).
    const paidOrders = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.ownerUserId, userId), eq(orders.status, 'paid')))
      .orderBy(desc(orders.id))
      .limit(1);
    const awaitingFinalization = await Promise.all(
      paidOrders.map(async (o) => ({
        order_id: o.id,
        carts: (
          await this.db
            .select()
            .from(carts)
            .where(eq(carts.orderId, o.id))
            .orderBy(asc(carts.id))
        ).map((c) => ({
          ifood_cart_id: c.ifoodCartId,
          restaurant: cartLabel(c),
        })),
      })),
    );

    if (!active) {
      return {
        order: null,
        hint: 'Não há pedido em andamento. Ele é criado ao cadastrar participantes ou carrinhos.',
        awaiting_finalization: awaitingFinalization,
      };
    }

    const people = await this.db
      .select()
      .from(participants)
      .where(eq(participants.orderId, active.id))
      .orderBy(asc(participants.id));
    const nameById = new Map(people.map((p) => [p.id, p.name]));
    const cartRows = await this.db
      .select()
      .from(carts)
      .where(eq(carts.orderId, active.id))
      .orderBy(asc(carts.id));
    const problems: string[] = [];
    const preview: Array<Record<string, string>> = [];

    const cartViews = [];
    for (const cart of cartRows) {
      const items = await this.db
        .select()
        .from(cartItems)
        .where(eq(cartItems.cartId, cart.id))
        .orderBy(asc(cartItems.id));
      const payerNames = [
        ...new Set(
          items
            .map((i) =>
              i.payerParticipantId ? nameById.get(i.payerParticipantId) : null,
            )
            .filter((n): n is string => !!n),
        ),
      ];
      cartViews.push({
        ifood_cart_id: cart.ifoodCartId,
        restaurant: cartLabel(cart),
        status: cart.status,
        subtotal: formatBRL(toCents(cart.subtotal)),
        total: formatBRL(toCents(cart.total)),
        items: items.map((i) => ({
          item_id: i.ifoodItemId,
          name: i.name,
          unit_price: formatBRL(toCents(i.unitPrice)),
          quantity: i.quantity,
          payer: i.payerParticipantId
            ? (nameById.get(i.payerParticipantId) ?? null)
            : null,
        })),
        payers: payerNames,
      });

      if (active.status === 'collecting') {
        try {
          const amounts = splitCart(
            items.map((i) => ({
              name: i.name,
              priceCents: toCents(i.unitPrice),
              quantity: i.quantity,
              payerId: i.payerParticipantId,
            })),
            toCents(cart.subtotal),
            toCents(cart.total),
          );
          for (const a of amounts) {
            preview.push({
              cart: cartLabel(cart),
              participant: nameById.get(a.payerId) ?? String(a.payerId),
              items: formatBRL(a.itemsCents),
              fees_share: formatBRL(a.feesCents),
              total: formatBRL(a.amountCents),
            });
          }
        } catch (err) {
          if (!(err instanceof GroupOrderError)) throw err;
          problems.push(`${cartLabel(cart)}: ${err.message}`);
        }
      }
    }

    const paymentRows = await this.loadPayments(active.id);
    const now = Date.now();
    const paymentViews = paymentRows
      .filter((p) => p.status !== 'void')
      .map((p) => {
        const expired =
          p.status === 'pending' &&
          p.expiresAt !== null &&
          p.expiresAt.getTime() < now;
        if (expired) {
          problems.push(
            `O link de ${p.participantName} expirou: use group_reopen_order e depois group_confirm_order para gerar novos.`,
          );
        }
        if (p.status === 'pending' && !p.payUrl) {
          problems.push(
            `O link de ${p.participantName} ainda não foi gerado: chame group_confirm_order de novo.`,
          );
        }
        return {
          participant: p.participantName,
          restaurant: p.restaurantName ?? p.ifoodCartId,
          amount: formatBRL(toCents(p.amount)),
          status: expired ? 'expired' : p.status,
        };
      });

    if (people.length === 0 && cartRows.length > 0) {
      problems.push(
        'Há carrinhos mas nenhum participante: use group_add_participant.',
      );
    }

    return {
      order: { id: active.id, status: active.status },
      participants: people.map((p) => p.name),
      carts: cartViews,
      ...(preview.length ? { amounts_preview: preview } : {}),
      payments: paymentViews,
      problems,
      awaiting_finalization: awaitingFinalization,
    };
  }

  // ───────────────────────── montagem ─────────────────────────

  async addParticipant(userId: number, rawName: string) {
    const display = cleanName(rawName);
    return this.db.transaction(async (tx) => {
      const order = await this.requireCollecting(tx, userId, true);
      const inserted = await tx
        .insert(participants)
        .values({
          orderId: order.id,
          name: display,
          nameKey: normalizeName(display),
        })
        .onConflictDoNothing({
          target: [participants.orderId, participants.nameKey],
        })
        .returning();
      const all = await tx
        .select({ name: participants.name, key: participants.nameKey })
        .from(participants)
        .where(eq(participants.orderId, order.id))
        .orderBy(asc(participants.id));
      const stored =
        inserted[0]?.name ??
        all.find((p) => p.key === normalizeName(display))!.name;
      return {
        created: inserted.length > 0,
        participant: stored,
        participants: all.map((p) => p.name),
      };
    });
  }

  // Espelha um carrinho do iFood no pedido: cria/atualiza o carrinho e SINCRONIZA os itens
  // (os que não vierem na lista são removidos). O pagador dos itens que continuam é preservado.
  async syncCart(
    userId: number,
    input: SyncCartInput,
  ): Promise<SyncCartResult> {
    const subtotalCents = toCents(input.subtotal, 'subtotal');
    const totalCents = toCents(input.total, 'total');
    if (subtotalCents < 0 || totalCents < 0) {
      throw new GroupOrderError('subtotal e total não podem ser negativos.');
    }
    const seen = new Set<string>();
    const items = input.items.map((item) => {
      if (seen.has(item.itemId)) {
        throw new GroupOrderError(
          `item_id repetido: ${item.itemId}. Cada linha precisa de um item_id único (use o id da linha do carrinho se o mesmo produto aparece com opções diferentes).`,
        );
      }
      seen.add(item.itemId);
      const priceCents = toCents(item.unitPrice, `preço de ${item.name}`);
      if (priceCents < 0)
        throw new GroupOrderError(`Preço negativo em ${item.name}.`);
      return { ...item, priceCents };
    });

    return this.db.transaction(async (tx) => {
      const order = await this.requireCollecting(tx, userId, true);

      if (items.length === 0) {
        const removed = await tx
          .delete(carts)
          .where(
            and(
              eq(carts.orderId, order.id),
              eq(carts.ifoodCartId, input.ifoodCartId),
            ),
          )
          .returning({ id: carts.id });
        return {
          removed: removed.length > 0,
          ifood_cart_id: input.ifoodCartId,
        };
      }

      const columns = {
        restaurantName: input.restaurantName,
        subtotal: fromCents(subtotalCents),
        total: fromCents(totalCents),
      };
      const [cart] = await tx
        .insert(carts)
        .values({
          orderId: order.id,
          ifoodCartId: input.ifoodCartId,
          ...columns,
        })
        .onConflictDoUpdate({
          target: [carts.orderId, carts.ifoodCartId],
          set: columns,
        })
        .returning();

      for (const item of items) {
        const itemColumns = {
          name: item.name,
          unitPrice: fromCents(item.priceCents),
          quantity: item.quantity,
        };
        await tx
          .insert(cartItems)
          .values({ cartId: cart.id, ifoodItemId: item.itemId, ...itemColumns })
          .onConflictDoUpdate({
            target: [cartItems.cartId, cartItems.ifoodItemId],
            set: itemColumns,
          });
      }
      await tx.delete(cartItems).where(
        and(
          eq(cartItems.cartId, cart.id),
          notInArray(
            cartItems.ifoodItemId,
            items.map((i) => i.itemId),
          ),
        ),
      );
      await this.dropOrphanPayers(tx, cart.id);
      return this.cartSummary(tx, cart);
    });
  }

  async assignPayer(
    userId: number,
    input: AssignPayerInput,
  ): Promise<CartSummary> {
    return this.db.transaction(async (tx) => {
      const order = await this.requireCollecting(tx, userId, false);
      const cart = await this.findCart(tx, order.id, input.ifoodCartId);

      const [item] = await tx
        .select()
        .from(cartItems)
        .where(
          and(
            eq(cartItems.cartId, cart.id),
            eq(cartItems.ifoodItemId, input.itemId),
          ),
        );
      if (!item) {
        const known = await tx
          .select({ id: cartItems.ifoodItemId, name: cartItems.name })
          .from(cartItems)
          .where(eq(cartItems.cartId, cart.id));
        throw new GroupOrderError(
          `Item ${input.itemId} não existe no carrinho ${cartLabel(cart)}. Itens: ${known.map((k) => `${k.id} (${k.name})`).join(', ') || 'nenhum'}.`,
        );
      }

      const participant = await this.findParticipant(
        tx,
        order.id,
        input.participantName,
      );

      const [existing] = await tx
        .select()
        .from(cartPayers)
        .where(eq(cartPayers.participantId, participant.id));
      if (existing && existing.cartId !== cart.id) {
        const [other] = await tx
          .select()
          .from(carts)
          .where(eq(carts.id, existing.cartId));
        throw new GroupOrderError(
          `${participant.name} já paga o carrinho ${cartLabel(other)}. Cada pessoa paga em um carrinho só: indique outra pessoa para este item.`,
        );
      }

      try {
        await tx
          .insert(cartPayers)
          .values({ cartId: cart.id, participantId: participant.id })
          .onConflictDoNothing();
        await tx
          .update(cartItems)
          .set({ payerParticipantId: participant.id })
          .where(eq(cartItems.id, item.id));
      } catch (err) {
        const code = pgErrorCode(err);
        if (code === PG_UNIQUE_VIOLATION || code === PG_FK_VIOLATION) {
          throw new GroupOrderError(
            `Não foi possível definir ${participant.name} como pagador deste item (cada pessoa paga em um carrinho só).`,
          );
        }
        throw err;
      }
      // Quem pagava este item antes pode ter ficado sem nenhum item no carrinho.
      await this.dropOrphanPayers(tx, cart.id);
      return this.cartSummary(tx, cart);
    });
  }

  // ───────────────────────── confirmação e pagamento ─────────────────────────

  // 1) valida e calcula quanto cada pessoa paga (transação); 2) pede os links ao provedor.
  // Pode ser chamada de novo: se o pedido já está em pagamento, só gera os links que faltam e
  // devolve todos os pendentes (serve também para "reenviar os links").
  async confirmOrder(userId: number) {
    const phase1 = await this.db.transaction(async (tx) => {
      const order = await this.findActiveOrder(tx, userId);
      if (!order) throw new GroupOrderError('Não há pedido em andamento.');
      if (order.status === 'paying')
        return { orderId: order.id, alreadyConfirmed: true };

      const cartRows = await tx
        .select()
        .from(carts)
        .where(eq(carts.orderId, order.id))
        .orderBy(asc(carts.id));
      if (cartRows.length === 0) {
        throw new GroupOrderError(
          'O pedido não tem carrinhos. Registre-os com group_sync_cart.',
        );
      }

      const plan: Array<{ cart: CartRow; amounts: PayerAmount[] }> = [];
      for (const cart of cartRows) {
        const items = await tx
          .select()
          .from(cartItems)
          .where(eq(cartItems.cartId, cart.id))
          .orderBy(asc(cartItems.id));
        if (items.length === 0) {
          throw new GroupOrderError(
            `O carrinho ${cartLabel(cart)} está vazio.`,
          );
        }
        let amounts: PayerAmount[];
        try {
          amounts = splitCart(
            items.map((i) => ({
              name: i.name,
              priceCents: toCents(i.unitPrice),
              quantity: i.quantity,
              payerId: i.payerParticipantId,
            })),
            toCents(cart.subtotal),
            toCents(cart.total),
          );
        } catch (err) {
          if (err instanceof GroupOrderError) {
            throw new GroupOrderError(
              `Carrinho ${cartLabel(cart)}: ${err.message}`,
            );
          }
          throw err;
        }
        const zero = amounts.find((a) => a.amountCents <= 0);
        if (zero) {
          throw new GroupOrderError(
            `Carrinho ${cartLabel(cart)}: o valor de um dos pagadores ficaria zerado ou negativo (${formatBRL(zero.amountCents)}). Revise itens, descontos e pagadores.`,
          );
        }
        plan.push({ cart, amounts });
      }

      for (const { cart, amounts } of plan) {
        for (const a of amounts) {
          await tx.insert(payments).values({
            cartId: cart.id,
            participantId: a.payerId,
            amount: fromCents(a.amountCents),
          });
        }
      }
      await tx
        .update(carts)
        .set({ status: 'confirmed' })
        .where(eq(carts.orderId, order.id));
      await tx
        .update(orders)
        .set({ status: 'paying' })
        .where(eq(orders.id, order.id));
      this.logger.log(
        `[group] pedido ${order.id} confirmado: ${plan.reduce((n, p) => n + p.amounts.length, 0)} cobrança(s)`,
      );
      return { orderId: order.id, alreadyConfirmed: false };
    });

    const failed = await this.ensureCharges(phase1.orderId);
    const links = await this.pendingLinks(phase1.orderId);
    const rows = (await this.loadPayments(phase1.orderId)).filter(
      (p) => p.status !== 'void',
    );
    return {
      alreadyConfirmed: phase1.alreadyConfirmed,
      payments: rows.map((p) => ({
        participant: p.participantName,
        restaurant: p.restaurantName ?? p.ifoodCartId,
        amount: formatBRL(toCents(p.amount)),
        status: p.status,
      })),
      links,
      failed,
    };
  }

  // Volta o pedido para edição, anulando os links pendentes. Só se ninguém pagou ainda.
  reopenOrder(userId: number) {
    return this.release(userId, 'reopen');
  }

  // Desiste do pedido (anula os links pendentes). Só se ninguém pagou ainda.
  cancelOrder(userId: number) {
    return this.release(userId, 'cancel');
  }

  async markFinalized(userId: number, orderId?: number) {
    return this.db.transaction(async (tx) => {
      const paid = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.ownerUserId, userId), eq(orders.status, 'paid')))
        .orderBy(asc(orders.id))
        .for('update');
      if (paid.length === 0) {
        throw new GroupOrderError(
          'Não há pedido totalmente pago aguardando finalização.',
        );
      }
      let target: OrderRow | undefined;
      if (orderId !== undefined) {
        target = paid.find((o) => o.id === orderId);
        if (!target) {
          throw new GroupOrderError(
            `O pedido ${orderId} não está aguardando finalização. Pedidos pagos: ${paid.map((o) => o.id).join(', ')}.`,
          );
        }
      } else if (paid.length === 1) {
        target = paid[0];
      } else {
        throw new GroupOrderError(
          `Há mais de um pedido pago (${paid.map((o) => o.id).join(', ')}). Informe o order_id.`,
        );
      }
      await tx
        .update(orders)
        .set({ status: 'completed' })
        .where(eq(orders.id, target.id));
      return { order_id: target.id, status: 'completed' as const };
    });
  }

  // ───────────────────────── internos ─────────────────────────

  private async findActiveOrder(
    tx: Tx,
    userId: number,
  ): Promise<OrderRow | undefined> {
    const [order] = await tx
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.ownerUserId, userId),
          inArray(orders.status, ['collecting', 'paying']),
        ),
      )
      .orderBy(desc(orders.id))
      .limit(1)
      .for('update');
    return order;
  }

  private async requireCollecting(
    tx: Tx,
    userId: number,
    create: boolean,
  ): Promise<OrderRow> {
    let order = await this.findActiveOrder(tx, userId);
    if (!order) {
      if (!create) {
        throw new GroupOrderError(
          'Não há pedido em andamento. Cadastre participantes e carrinhos primeiro.',
        );
      }
      // Quem começa um pedido novo desistiu do anterior que ficou pago mas nunca foi enviado
      // (ex.: o envio deu erro): ele é descartado e não volta à conversa.
      const abandoned = await tx
        .update(orders)
        .set({ status: 'cancelled' })
        .where(and(eq(orders.ownerUserId, userId), eq(orders.status, 'paid')))
        .returning({ id: orders.id });
      [order] = await tx
        .insert(orders)
        .values({ ownerUserId: userId })
        .returning();
      this.logger.log(
        `[group] pedido ${order.id} criado para o usuário ${userId}` +
          (abandoned.length
            ? ` (descartado(s) o(s) pedido(s) pago(s) não enviado(s): ${abandoned.map((o) => o.id).join(', ')})`
            : ''),
      );
    }
    if (order.status !== 'collecting') {
      throw new GroupOrderError(
        'O pedido já foi confirmado e aguarda pagamento. Para alterar, use group_reopen_order (só funciona se ninguém pagou ainda); para desistir, group_cancel_order.',
      );
    }
    return order;
  }

  private async findCart(
    tx: Tx,
    orderId: number,
    ifoodCartId: string,
  ): Promise<CartRow> {
    const [cart] = await tx
      .select()
      .from(carts)
      .where(
        and(eq(carts.orderId, orderId), eq(carts.ifoodCartId, ifoodCartId)),
      );
    if (!cart) {
      const known = await tx
        .select()
        .from(carts)
        .where(eq(carts.orderId, orderId));
      throw new GroupOrderError(
        `Carrinho ${ifoodCartId} não está registrado no pedido. Registrados: ${known.map((c) => `${c.ifoodCartId} (${cartLabel(c)})`).join(', ') || 'nenhum'}. Use group_sync_cart.`,
      );
    }
    return cart;
  }

  private async findParticipant(tx: Tx, orderId: number, rawName: string) {
    const name = cleanName(rawName);
    const [participant] = await tx
      .select()
      .from(participants)
      .where(
        and(
          eq(participants.orderId, orderId),
          eq(participants.nameKey, normalizeName(name)),
        ),
      );
    if (!participant) {
      const known = await tx
        .select({ name: participants.name })
        .from(participants)
        .where(eq(participants.orderId, orderId));
      throw new GroupOrderError(
        `Participante "${name}" não existe. Participantes: ${known.map((k) => k.name).join(', ') || 'nenhum'}. Use group_add_participant.`,
      );
    }
    return participant;
  }

  // Remove de cart_payers quem não tem mais nenhum item no carrinho (liberando a pessoa para
  // pagar outro carrinho).
  private async dropOrphanPayers(tx: Tx, cartId: number): Promise<void> {
    await tx.execute(sql`
      DELETE FROM cart_payers cp
       WHERE cp.cart_id = ${cartId}
         AND NOT EXISTS (
           SELECT 1 FROM cart_items ci
            WHERE ci.cart_id = cp.cart_id AND ci.payer_participant_id = cp.participant_id
         )`);
  }

  private async cartSummary(tx: Tx, cart: CartRow): Promise<CartSummary> {
    const [fresh] = await tx.select().from(carts).where(eq(carts.id, cart.id));
    const items = await tx
      .select({
        itemId: cartItems.ifoodItemId,
        name: cartItems.name,
        unitPrice: cartItems.unitPrice,
        quantity: cartItems.quantity,
        payer: participants.name,
      })
      .from(cartItems)
      .leftJoin(participants, eq(participants.id, cartItems.payerParticipantId))
      .where(eq(cartItems.cartId, cart.id))
      .orderBy(asc(cartItems.id));

    const itemsTotal = items.reduce(
      (n, i) => n + toCents(i.unitPrice) * i.quantity,
      0,
    );
    const warnings: string[] = [];
    if (itemsTotal !== toCents(fresh.subtotal)) {
      warnings.push(
        `A soma dos itens (${formatBRL(itemsTotal)}) não bate com o subtotal (${formatBRL(toCents(fresh.subtotal))}). Corrija antes de confirmar.`,
      );
    }
    const unassigned = items.filter((i) => !i.payer).map((i) => i.name);
    if (unassigned.length)
      warnings.push(`Itens sem pagador: ${unassigned.join(', ')}.`);

    return {
      ifood_cart_id: fresh.ifoodCartId,
      restaurant: cartLabel(fresh),
      subtotal: formatBRL(toCents(fresh.subtotal)),
      total: formatBRL(toCents(fresh.total)),
      items: items.map((i) => ({
        item_id: i.itemId,
        name: i.name,
        unit_price: formatBRL(toCents(i.unitPrice)),
        quantity: i.quantity,
        payer: i.payer,
      })),
      warnings,
    };
  }

  private loadPayments(orderId: number) {
    return this.db
      .select({
        id: payments.id,
        cartId: payments.cartId,
        participantId: payments.participantId,
        amount: payments.amount,
        status: payments.status,
        payUrl: payments.payUrl,
        expiresAt: payments.expiresAt,
        participantName: participants.name,
        restaurantName: carts.restaurantName,
        ifoodCartId: carts.ifoodCartId,
        externalPaymentId: payments.externalPaymentId,
      })
      .from(payments)
      .innerJoin(carts, eq(carts.id, payments.cartId))
      .innerJoin(participants, eq(participants.id, payments.participantId))
      .where(eq(carts.orderId, orderId))
      .orderBy(asc(payments.id));
  }

  // Pede ao provedor os links das cobranças pendentes que ainda não têm. Devolve os nomes de quem
  // ficou sem link (provedor fora do ar etc.); o pedido continua válido e dá para tentar de novo.
  private async ensureCharges(orderId: number): Promise<string[]> {
    const failed: string[] = [];
    const rows = await this.loadPayments(orderId);
    for (const p of rows.filter((r) => r.status === 'pending' && !r.payUrl)) {
      try {
        const items = await this.db
          .select({ name: cartItems.name, quantity: cartItems.quantity })
          .from(cartItems)
          .where(
            and(
              eq(cartItems.cartId, p.cartId),
              eq(cartItems.payerParticipantId, p.participantId),
            ),
          )
          .orderBy(asc(cartItems.id));
        const description =
          `${p.restaurantName ?? 'iFood'} — ${p.participantName}: ${items
            .map((i) => `${i.quantity}x ${i.name}`)
            .join(', ')}`.slice(0, 280);
        await this.paymentsService.issueCharge({
          id: p.id,
          amountCents: toCents(p.amount),
          description,
        });
      } catch (err) {
        this.logger.error(
          `[group] falha ao gerar link do pagamento ${p.id}: ${String(err)}`,
        );
        failed.push(p.participantName);
      }
    }
    await this.paymentsService.chargesIssued(orderId);
    return failed;
  }

  private async pendingLinks(orderId: number): Promise<PaymentLink[]> {
    return (await this.loadPayments(orderId))
      .filter((p) => p.status === 'pending' && p.payUrl)
      .map((p) => ({
        participant: p.participantName,
        restaurant: p.restaurantName ?? p.ifoodCartId,
        amount: formatBRL(toCents(p.amount)),
        url: p.payUrl as string,
      }));
  }

  private async release(userId: number, mode: 'reopen' | 'cancel') {
    const verb = mode === 'reopen' ? 'alterar' : 'cancelar';
    const snapshot = await this.db.transaction(async (tx) => {
      const order = await this.findActiveOrder(tx, userId);
      if (!order) {
        if (await this.hasPaidOrder(userId)) {
          throw new GroupOrderError(
            'O pedido já está totalmente pago: não dá mais para alterá-lo nem cancelá-lo. Finalize-o no iFood.',
          );
        }
        throw new GroupOrderError('Não há pedido em andamento.');
      }
      if (mode === 'reopen' && order.status !== 'paying') {
        throw new GroupOrderError(
          'O pedido ainda está em montagem; não há o que reabrir.',
        );
      }
      const rows = await this.loadPaymentsTx(tx, order.id);
      this.assertNobodyPaid(rows, verb);
      return {
        orderId: order.id,
        wasCollecting: order.status === 'collecting',
        pending: rows.filter((r) => r.status === 'pending'),
      };
    });

    // Cancela os links no provedor (fora da transação: é uma chamada de rede). O cancelamento é
    // condicional lá: se alguém pagou nesse meio tempo, o provedor recusa (409) e abortamos.
    const cancelled: typeof snapshot.pending = [];
    try {
      for (const p of snapshot.pending) {
        if (!p.externalPaymentId) continue; // o link nunca chegou a existir
        let result;
        try {
          result = await this.paymentsService.cancelCharge(p.id);
        } catch (err) {
          this.logger.error(
            `[group] falha ao cancelar a cobrança ${p.id}: ${String(err)}`,
          );
          throw new GroupOrderError(
            'Não consegui cancelar os links de pagamento agora (provedor indisponível). Tente de novo em instantes.',
          );
        }
        if (result === 'paid') {
          throw new GroupOrderError(
            `${p.participantName} acabou de pagar: não dá mais para ${verb} o pedido. Use group_get_order para ver o estado.`,
          );
        }
        cancelled.push(p);
      }
    } catch (err) {
      await this.reissue(snapshot.orderId, cancelled);
      throw err;
    }

    await this.db.transaction(async (tx) => {
      await tx
        .select()
        .from(orders)
        .where(eq(orders.id, snapshot.orderId))
        .for('update');
      this.assertNobodyPaid(
        await this.loadPaymentsTx(tx, snapshot.orderId),
        verb,
      );

      const cartIds = (
        await tx
          .select({ id: carts.id })
          .from(carts)
          .where(eq(carts.orderId, snapshot.orderId))
      ).map((c) => c.id);
      if (cartIds.length) {
        await tx
          .update(payments)
          .set({ status: 'void' })
          .where(
            and(
              inArray(payments.cartId, cartIds),
              eq(payments.status, 'pending'),
            ),
          );
      }
      if (mode === 'reopen') {
        await tx
          .update(carts)
          .set({ status: 'pending' })
          .where(eq(carts.orderId, snapshot.orderId));
        await tx
          .update(orders)
          .set({ status: 'collecting' })
          .where(eq(orders.id, snapshot.orderId));
      } else {
        await tx
          .update(orders)
          .set({ status: 'cancelled' })
          .where(eq(orders.id, snapshot.orderId));
      }
    });
    this.logger.log(
      `[group] pedido ${snapshot.orderId} ${mode === 'reopen' ? 'reaberto' : 'cancelado'}`,
    );
    return {
      order_id: snapshot.orderId,
      status: mode === 'reopen' ? 'collecting' : 'cancelled',
    };
  }

  // Se o cancelamento foi interrompido no meio, os links já cancelados no provedor estão mortos
  // mas continuam "pendentes" aqui. Troca cada um por uma cobrança nova (mesmo valor, novo link).
  private async reissue(
    orderId: number,
    dead: Array<{ id: number }>,
  ): Promise<void> {
    if (dead.length === 0) return;
    try {
      await this.db.transaction(async (tx) => {
        for (const { id } of dead) {
          const [old] = await tx
            .select()
            .from(payments)
            .where(eq(payments.id, id));
          await tx
            .update(payments)
            .set({ status: 'void' })
            .where(eq(payments.id, id));
          await tx.insert(payments).values({
            cartId: old.cartId,
            participantId: old.participantId,
            amount: old.amount,
          });
        }
      });
      await this.ensureCharges(orderId);
    } catch (err) {
      this.logger.error(
        `[group] falha ao reemitir links do pedido ${orderId}: ${String(err)}`,
      );
    }
  }

  private loadPaymentsTx(tx: Tx, orderId: number) {
    return tx
      .select({
        id: payments.id,
        status: payments.status,
        participantName: participants.name,
        externalPaymentId: payments.externalPaymentId,
      })
      .from(payments)
      .innerJoin(carts, eq(carts.id, payments.cartId))
      .innerJoin(participants, eq(participants.id, payments.participantId))
      .where(eq(carts.orderId, orderId));
  }

  private assertNobodyPaid(
    rows: Array<{ status: string; participantName: string }>,
    verb: string,
  ) {
    const paid = rows
      .filter((r) => r.status === 'paid')
      .map((r) => r.participantName);
    if (paid.length) {
      throw new GroupOrderError(
        `${paid.join(', ')} já pagou(aram): não dá para ${verb} o pedido. Use group_get_order para ver o estado.`,
      );
    }
  }
}
