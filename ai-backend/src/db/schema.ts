import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  foreignKey,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const orderStatus = pgEnum('order_status', [
  'collecting',
  'confirmed',
  'paying',
  'paid',
  'cancelled',
  'completed',
]);
export const cartStatus = pgEnum('cart_status', [
  'pending',
  'confirmed',
  'paid',
]);
export const messageRole = pgEnum('message_role', [
  'user',
  'assistant',
  'tool',
]);
export const paymentStatus = pgEnum('payment_status', [
  'pending',
  'paid',
  'void',
]);

export type ChatChannel = 'telegram' | 'whatsapp';

// id é o chatId interno usado no resto do código; external_id é o id do chat no canal.
export const chats = pgTable(
  'chats',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    channel: text('channel').$type<ChatChannel>().notNull(),
    externalId: text('external_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex().on(t.channel, t.externalId)],
);

export const users = pgTable('users', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull(),
  // Nulo até sabermos o e-mail: o usuário nasce no primeiro contato pelo chat.
  email: text('email').unique(),
  chatId: bigint('chat_id', { mode: 'number' })
    .unique()
    .references(() => chats.id),
  // ifoodToken = access token do OAuth do iFood.
  ifoodToken: text('ifood_token'),
  ifoodRefreshToken: text('ifood_refresh_token'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
});

export const orders = pgTable('orders', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ownerUserId: bigint('owner_user_id', { mode: 'number' })
    .notNull()
    .references(() => users.id),
  status: orderStatus('status').notNull().default('collecting'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const carts = pgTable('carts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  orderId: bigint('order_id', { mode: 'number' })
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  ifoodCartId: text('ifood_cart_id').notNull(),
  restaurantName: text('restaurant_name'),
  subtotal: numeric('subtotal', { precision: 10, scale: 2 }).notNull(),
  total: numeric('total', { precision: 10, scale: 2 }).notNull(),
  status: cartStatus('status').notNull().default('pending'),
});

export const messages = pgTable('messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  chatId: bigint('chat_id', { mode: 'number' })
    .notNull()
    .references(() => chats.id, { onDelete: 'cascade' }),
  userId: bigint('user_id', { mode: 'number' }).references(() => users.id),
  role: messageRole('role').notNull(),
  // Texto legível (o que o usuário viu ou um resumo da ferramenta).
  content: text('content').notNull(),
  // Blocos de conteúdo da Anthropic (tool_use / tool_result) para reconstruir a conversa fielmente.
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// O DDL de verdade está em db/init.sql: aqui ficam só os tipos para as queries.

export const participants = pgTable('participants', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  orderId: bigint('order_id', { mode: 'number' })
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // Nome normalizado (minúsculo, sem acento) usado para achar a pessoa pelo que o LLM escreveu.
  nameKey: text('name_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// UNIQUE (participant_id) no banco = uma pessoa paga em um carrinho só.
export const cartPayers = pgTable(
  'cart_payers',
  {
    cartId: bigint('cart_id', { mode: 'number' })
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    participantId: bigint('participant_id', { mode: 'number' })
      .notNull()
      .unique()
      .references(() => participants.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.cartId, t.participantId] })],
);

export const cartItems = pgTable(
  'cart_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    cartId: bigint('cart_id', { mode: 'number' })
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    ifoodItemId: text('ifood_item_id').notNull(),
    name: text('name').notNull(),
    unitPrice: numeric('unit_price', { precision: 10, scale: 2 }).notNull(),
    quantity: integer('quantity').notNull(),
    // Nulo = item ainda sem pagador.
    payerParticipantId: bigint('payer_participant_id', { mode: 'number' }),
  },
  (t) => [
    foreignKey({
      columns: [t.cartId, t.payerParticipantId],
      foreignColumns: [cartPayers.cartId, cartPayers.participantId],
    }),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    cartId: bigint('cart_id', { mode: 'number' })
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    participantId: bigint('participant_id', { mode: 'number' })
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    status: paymentStatus('status').notNull().default('pending'),
    externalPaymentId: text('external_payment_id'),
    payUrl: text('pay_url'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_payments_participant_active')
      .on(t.participantId)
      .where(sql`${t.status} <> 'void'`),
  ],
);

export const processedEvents = pgTable('processed_events', {
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const oauthPendingLogins = pgTable('oauth_pending_logins', {
  state: text('state').primaryKey(),
  chatId: bigint('chat_id', { mode: 'number' })
    .notNull()
    .references(() => chats.id, { onDelete: 'cascade' }),
  // code_verifier do PKCE, cifrado.
  codeVerifierEnc: text('code_verifier_enc').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const dietaryRestrictions = pgTable(
  'dietary_restrictions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // '' = o próprio usuário; senão, o nome normalizado de quem vai comer.
    personKey: text('person_key').notNull().default(''),
    personName: text('person_name'),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    category: text('category')
      .$type<'alergia' | 'intolerancia' | 'religiao' | 'dieta'>()
      .notNull(),
    customTerms: jsonb('custom_terms').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex().on(t.userId, t.personKey, t.kind)],
);

export interface TraceTool {
  name: string;
  ok: boolean;
  ms: number;
}

export const agentTurns = pgTable('agent_turns', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  chatId: bigint('chat_id', { mode: 'number' })
    .notNull()
    .references(() => chats.id, { onDelete: 'cascade' }),
  userId: bigint('user_id', { mode: 'number' }).references(() => users.id, {
    onDelete: 'set null',
  }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  durationMs: integer('duration_ms').notNull(),
  rounds: integer('rounds').notNull(),
  // reply | tool_limit | refusal | error
  outcome: text('outcome').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  tools: jsonb('tools').$type<TraceTool[]>().notNull().default([]),
  validatorHits: jsonb('validator_hits')
    .$type<string[]>()
    .notNull()
    .default([]),
  error: text('error'),
});
