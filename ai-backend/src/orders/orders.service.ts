import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { orders } from '../db/schema.js';

export type Order = typeof orders.$inferSelect;
export type OrderStatus = Order['status'];

@Injectable()
export class OrdersService {
  constructor(private readonly database: DbService) {}

  private get db() {
    return this.database.db;
  }

  async create(ownerUserId: number): Promise<Order> {
    const [order] = await this.db
      .insert(orders)
      .values({ ownerUserId })
      .returning();
    return order;
  }

  async findById(id: number): Promise<Order | undefined> {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, id));
    return order;
  }

  listByOwner(ownerUserId: number): Promise<Order[]> {
    return this.db
      .select()
      .from(orders)
      .where(eq(orders.ownerUserId, ownerUserId))
      .orderBy(desc(orders.id));
  }

  async setStatus(id: number, status: OrderStatus): Promise<void> {
    await this.db.update(orders).set({ status }).where(eq(orders.id, id));
  }
}
