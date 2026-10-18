import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { cartItems, carts, orders, participants } from '../db/schema.js';
import { GroupOrderError } from './group-order.errors.js';
import { cartLabel, type OrderView } from './group-order.types.js';
import { formatBRL, toCents } from './money.js';
import { loadPayments } from './order.lookups.js';
import { splitCart } from './split.js';

// Leituras do pedido em grupo (nada aqui trava ou altera linhas).
@Injectable()
export class OrderQueryService {
  constructor(private readonly database: DbService) {}

  private get db() {
    return this.database.db;
  }

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

    const paymentRows = await loadPayments(this.db, active.id);
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
}
