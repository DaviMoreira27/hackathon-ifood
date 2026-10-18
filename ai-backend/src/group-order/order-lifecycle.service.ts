import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { carts, cartItems, orders, payments } from '../db/schema.js';
import { ChargesService } from './charges.service.js';
import { GroupOrderError } from './group-order.errors.js';
import { cartLabel, type CartRow } from './group-order.types.js';
import { formatBRL, fromCents, toCents } from './money.js';
import {
  assertNobodyPaid,
  findActiveOrder,
  loadPayments,
  loadPaymentsTx,
} from './order.lookups.js';
import { OrderQueryService } from './order-query.service.js';
import { splitCart, type PayerAmount } from './split.js';

// Ciclo de vida do pedido em grupo depois da montagem: confirmar (gera as cobranças), reabrir e
// cancelar (anulam os links pendentes). Mesmas travas de OrderCommandService: cada transação
// trava a linha do pedido, e nada é desfeito depois que alguém pagou.
@Injectable()
export class OrderLifecycleService {
  private readonly logger = new Logger(OrderLifecycleService.name);

  constructor(
    private readonly database: DbService,
    private readonly query: OrderQueryService,
    private readonly charges: ChargesService,
  ) {}

  private get db() {
    return this.database.db;
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
