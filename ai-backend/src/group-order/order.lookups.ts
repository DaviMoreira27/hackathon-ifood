import type { Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  cartItems,
  carts,
  orders,
  participants,
  payments,
} from '../db/schema.js';
import type { Database, Tx } from '../db/types.js';
import { GroupOrderError } from './group-order.errors.js';
import {
  cartLabel,
  cleanName,
  normalizeName,
  type CartRow,
  type CartSummary,
  type OrderRow,
} from './group-order.types.js';
import { formatBRL, toCents } from './money.js';

// Consultas e checagens compartilhadas pelos serviços do pedido em grupo.

// O pedido em montagem ou em pagamento, com a linha travada (FOR UPDATE) até o fim da transação.
export async function findActiveOrder(
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

export async function requireCollecting(
  tx: Tx,
  userId: number,
  create: boolean,
  logger: Logger,
): Promise<OrderRow> {
  let order = await findActiveOrder(tx, userId);
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
    logger.log(
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

export async function findCart(
  tx: Tx,
  orderId: number,
  ifoodCartId: string,
): Promise<CartRow> {
  const [cart] = await tx
    .select()
    .from(carts)
    .where(and(eq(carts.orderId, orderId), eq(carts.ifoodCartId, ifoodCartId)));
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

export async function findParticipant(
  tx: Tx,
  orderId: number,
  rawName: string,
) {
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
export async function dropOrphanPayers(tx: Tx, cartId: number): Promise<void> {
  await tx.execute(sql`
    DELETE FROM cart_payers cp
     WHERE cp.cart_id = ${cartId}
       AND NOT EXISTS (
         SELECT 1 FROM cart_items ci
          WHERE ci.cart_id = cp.cart_id AND ci.payer_participant_id = cp.participant_id
       )`);
}

export async function cartSummary(tx: Tx, cart: CartRow): Promise<CartSummary> {
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

export function loadPayments(db: Database, orderId: number) {
  return db
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

export function loadPaymentsTx(tx: Tx, orderId: number) {
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

export function assertNobodyPaid(
  rows: Array<{ status: string; participantName: string }>,
  verb: string,
): void {
  const paid = rows
    .filter((r) => r.status === 'paid')
    .map((r) => r.participantName);
  if (paid.length) {
    throw new GroupOrderError(
      `${paid.join(', ')} já pagou(aram): não dá para ${verb} o pedido. Use group_get_order para ver o estado.`,
    );
  }
}
