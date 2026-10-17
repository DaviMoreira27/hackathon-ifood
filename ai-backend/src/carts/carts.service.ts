import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { carts } from '../db/schema.js';

export type Cart = typeof carts.$inferSelect;
export type CartStatus = Cart['status'];
// Valores monetários vão como string ("42.90"): é o que o Postgres devolve para NUMERIC.
export type NewCart = Pick<
  typeof carts.$inferInsert,
  'orderId' | 'ifoodCartId' | 'subtotal' | 'total'
>;

@Injectable()
export class CartsService {
  constructor(private readonly database: DbService) {}

  private get db() {
    return this.database.db;
  }

  async add(cart: NewCart): Promise<Cart> {
    const [created] = await this.db.insert(carts).values(cart).returning();
    return created;
  }

  listByOrder(orderId: number): Promise<Cart[]> {
    return this.db.select().from(carts).where(eq(carts.orderId, orderId));
  }

  async setStatus(id: number, status: CartStatus): Promise<void> {
    await this.db.update(carts).set({ status }).where(eq(carts.id, id));
  }
}
