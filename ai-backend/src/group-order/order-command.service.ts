import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
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
import { ChargesService } from './charges.service.js';
import { GroupOrderError } from './group-order.errors.js';
import {
  cartLabel,
  cleanName,
  normalizeName,
  type AssignPayerInput,
  type CartRow,
  type CartSummary,
  type OrderRow,
  type SyncCartInput,
  type SyncCartResult,
} from './group-order.types.js';
import { formatBRL, fromCents, toCents } from './money.js';
import {
  assertNobodyPaid,
  cartSummary,
  dropOrphanPayers,
  findActiveOrder,
  findCart,
  findParticipant,
  loadPayments,
  loadPaymentsTx,
  requireCollecting,
} from './order.lookups.js';
import { OrderQueryService } from './order-query.service.js';
import { splitCart, type PayerAmount } from './split.js';

const PG_FK_VIOLATION = '23503';
const PG_UNIQUE_VIOLATION = '23505';

// Escritas do pedido em grupo. Regras:
//  - cada restaurante é um carrinho; cada item tem exatamente um pagador;
//  - cada pessoa paga em NO MÁXIMO UM carrinho (garantido também pelo banco);
//  - o pedido só é cobrado depois de confirmado; reabrir só é possível se ninguém pagou.
// Toda escrita roda numa transação que trava a linha do pedido (FOR UPDATE): editar o pedido e
// aplicar um pagamento recebido pelo RabbitMQ nunca se atropelam.
@Injectable()
export class OrderCommandService {
  private readonly logger = new Logger(OrderCommandService.name);

  constructor(
    private readonly database: DbService,
    private readonly query: OrderQueryService,
    private readonly charges: ChargesService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async addParticipant(userId: number, rawName: string) {
    const display = cleanName(rawName);
    return this.db.transaction(async (tx) => {
      const order = await requireCollecting(tx, userId, true, this.logger);
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
      const order = await requireCollecting(tx, userId, true, this.logger);

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
      await dropOrphanPayers(tx, cart.id);
      return cartSummary(tx, cart);
    });
  }

  async assignPayer(
    userId: number,
    input: AssignPayerInput,
  ): Promise<CartSummary> {
    return this.db.transaction(async (tx) => {
      const order = await requireCollecting(tx, userId, false, this.logger);
      const cart = await findCart(tx, order.id, input.ifoodCartId);

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

      const participant = await findParticipant(
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
      await dropOrphanPayers(tx, cart.id);
      return cartSummary(tx, cart);
    });
  }

  // ───────────────────────── confirmação e pagamento ─────────────────────────

  // 1) valida e calcula quanto cada pessoa paga (transação); 2) pede os links ao provedor.
  // Pode ser chamada de novo: se o pedido já está em pagamento, só gera os links que faltam e
  // devolve todos os pendentes (serve também para "reenviar os links").
  async confirmOrder(userId: number) {
    const phase1 = await this.db.transaction(async (tx) => {
      const order = await findActiveOrder(tx, userId);
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

    const failed = await this.charges.ensureCharges(phase1.orderId);
    const links = await this.charges.pendingLinks(phase1.orderId);
    const rows = (await loadPayments(this.db, phase1.orderId)).filter(
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

  private async release(userId: number, mode: 'reopen' | 'cancel') {
    const verb = mode === 'reopen' ? 'alterar' : 'cancelar';
    const snapshot = await this.db.transaction(async (tx) => {
      const order = await findActiveOrder(tx, userId);
      if (!order) {
        if (await this.query.hasPaidOrder(userId)) {
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
      const rows = await loadPaymentsTx(tx, order.id);
      assertNobodyPaid(rows, verb);
      return {
        orderId: order.id,
        wasCollecting: order.status === 'collecting',
        pending: rows.filter((r) => r.status === 'pending'),
      };
    });

    await this.charges.cancelPending(snapshot.orderId, snapshot.pending, verb);

    await this.db.transaction(async (tx) => {
      await tx
        .select()
        .from(orders)
        .where(eq(orders.id, snapshot.orderId))
        .for('update');
      assertNobodyPaid(await loadPaymentsTx(tx, snapshot.orderId), verb);

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
}
