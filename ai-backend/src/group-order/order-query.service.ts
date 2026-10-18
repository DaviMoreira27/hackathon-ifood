import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { cartItems, carts, orders, participants } from '../db/schema.js';
import type { OrderView } from './group-order.types.js';
import { loadPayments } from './order.lookups.js';
import { buildOrderView } from './order-view.js';

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
    // Só o último pedido pago: pedidos antigos não voltam à conversa (um pedido novo descarta os
    // anteriores; ver requireCollecting).
    const [[active], paidOrders] = await Promise.all([
      this.db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.ownerUserId, userId),
            inArray(orders.status, ['collecting', 'paying']),
          ),
        )
        .orderBy(desc(orders.id))
        .limit(1),
      this.db
        .select()
        .from(orders)
        .where(and(eq(orders.ownerUserId, userId), eq(orders.status, 'paid')))
        .orderBy(desc(orders.id))
        .limit(1),
    ]);
    const orderIds = [active?.id, ...paidOrders.map((o) => o.id)].filter(
      (id): id is number => id !== undefined,
    );
    const [allCarts, people, paymentRows] = await Promise.all([
      orderIds.length
        ? this.db
            .select()
            .from(carts)
            .where(inArray(carts.orderId, orderIds))
            .orderBy(asc(carts.id))
        : Promise.resolve([]),
      active
        ? this.db
            .select()
            .from(participants)
            .where(eq(participants.orderId, active.id))
            .orderBy(asc(participants.id))
        : Promise.resolve([]),
      active ? loadPayments(this.db, active.id) : Promise.resolve([]),
    ]);
    const cartRows = active
      ? allCarts.filter((c) => c.orderId === active.id)
      : [];
    const itemRows = cartRows.length
      ? await this.db
          .select()
          .from(cartItems)
          .where(
            inArray(
              cartItems.cartId,
              cartRows.map((c) => c.id),
            ),
          )
          .orderBy(asc(cartItems.id))
      : [];
    return buildOrderView({
      active,
      paidOrders,
      carts: allCarts,
      participants: people,
      items: itemRows,
      payments: paymentRows,
      now: Date.now(),
    });
  }
}
