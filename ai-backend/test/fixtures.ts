import { inArray } from 'drizzle-orm';
import type { Database } from '../src/db/types.js';
import {
  cartPayers,
  carts,
  orders,
  participants,
  payments,
  users,
} from '../src/db/schema.js';

export interface FixtureCart {
  restaurant: string;
  subtotal: string;
  total: string;
  // Quem paga este carrinho e quanto (uma cobrança pendente por pagador).
  payers: Array<{ name: string; amount: string }>;
}

export interface PayingOrder {
  userId: number;
  orderId: number;
  carts: Array<{
    cartId: number;
    payers: Array<{ name: string; participantId: number; paymentId: number }>;
  }>;
}

// Cria direto no banco um pedido já confirmado (status 'paying') com cobranças pendentes.
export async function createPayingOrder(
  db: Database,
  chatId: number,
  fixtureCarts: FixtureCart[],
): Promise<PayingOrder> {
  const [user] = await db
    .insert(users)
    .values({ name: `Teste ${chatId}`, telegramChatId: chatId })
    .returning();
  const [order] = await db
    .insert(orders)
    .values({ ownerUserId: user.id, status: 'paying' })
    .returning();

  const result: PayingOrder = { userId: user.id, orderId: order.id, carts: [] };
  const participantIds = new Map<string, number>();

  for (const [index, fixtureCart] of fixtureCarts.entries()) {
    const [cart] = await db
      .insert(carts)
      .values({
        orderId: order.id,
        ifoodCartId: `fx-${chatId}-${index}`,
        restaurantName: fixtureCart.restaurant,
        subtotal: fixtureCart.subtotal,
        total: fixtureCart.total,
        status: 'confirmed',
      })
      .returning();

    const entry: PayingOrder['carts'][number] = { cartId: cart.id, payers: [] };
    for (const payer of fixtureCart.payers) {
      let participantId = participantIds.get(payer.name);
      if (!participantId) {
        const [participant] = await db
          .insert(participants)
          .values({
            orderId: order.id,
            name: payer.name,
            nameKey: payer.name.toLowerCase(),
          })
          .returning();
        participantId = participant.id;
        participantIds.set(payer.name, participantId);
      }
      await db.insert(cartPayers).values({ cartId: cart.id, participantId });
      const [payment] = await db
        .insert(payments)
        .values({
          cartId: cart.id,
          participantId,
          amount: payer.amount,
          externalPaymentId: `ext-${chatId}-${payer.name}`,
          payUrl: `http://localhost:5173/pay/fake-${payer.name}`,
        })
        .returning();
      entry.payers.push({
        name: payer.name,
        participantId,
        paymentId: payment.id,
      });
    }
    result.carts.push(entry);
  }
  return result;
}

// Apaga os usuários de teste (pedidos, carrinhos, participantes e pagamentos caem em cascata
// pelas FKs dos pedidos/carrinhos).
export async function deleteTestUsers(
  db: Database,
  chatIds: number[],
): Promise<void> {
  const found = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.telegramChatId, chatIds));
  const ids = found.map((u) => u.id);
  if (ids.length === 0) return;
  await db.delete(orders).where(inArray(orders.ownerUserId, ids));
  await db.delete(users).where(inArray(users.id, ids));
}

export async function createUser(db: Database, chatId: number) {
  const [user] = await db
    .insert(users)
    .values({ name: `Teste ${chatId}`, telegramChatId: chatId })
    .returning();
  return user;
}
