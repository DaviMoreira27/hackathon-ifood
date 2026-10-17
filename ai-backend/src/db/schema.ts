import { bigint, bigserial, numeric, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const orderStatus = pgEnum('order_status', ['collecting', 'confirmed', 'paying', 'paid']);
export const cartStatus = pgEnum('cart_status', ['pending', 'confirmed', 'paid']);
export const messageRole = pgEnum('message_role', ['user', 'assistant', 'tool']);

export const users = pgTable('users', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  ifoodToken: text('ifood_token'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
});

export const orders = pgTable('orders', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ownerUserId: bigint('owner_user_id', { mode: 'number' })
    .notNull()
    .references(() => users.id),
  status: orderStatus('status').notNull().default('collecting'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const carts = pgTable('carts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  orderId: bigint('order_id', { mode: 'number' })
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  ifoodCartId: text('ifood_cart_id').notNull(),
  subtotal: numeric('subtotal', { precision: 10, scale: 2 }).notNull(),
  total: numeric('total', { precision: 10, scale: 2 }).notNull(),
  status: cartStatus('status').notNull().default('pending'),
});

export const messages = pgTable('messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  chatId: bigint('chat_id', { mode: 'number' }).notNull(),
  userId: bigint('user_id', { mode: 'number' }).references(() => users.id),
  role: messageRole('role').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
