import type { cartItems, participants } from '../db/schema.js';
import { GroupOrderError } from './group-order.errors.js';
import {
  cartLabel,
  type CartRow,
  type OrderRow,
  type OrderView,
} from './group-order.types.js';
import { formatBRL, toCents } from './money.js';
import type { loadPayments } from './order.lookups.js';
import { splitCart } from './split.js';

export interface OrderViewRows {
  // Pedido em montagem ou em pagamento (o mais recente), se houver.
  active: OrderRow | undefined;
  // Último pedido pago aguardando o envio.
  paidOrders: OrderRow[];
  // Carrinhos do pedido ativo e dos pagos.
  carts: CartRow[];
  participants: Array<typeof participants.$inferSelect>;
  // Itens dos carrinhos do pedido ativo.
  items: Array<typeof cartItems.$inferSelect>;
  payments: Awaited<ReturnType<typeof loadPayments>>;
  now: number;
}

// Monta a OrderView (o que o LLM e o usuário veem do pedido) a partir das linhas já lidas do banco.
// Pura: a prévia de quem paga quanto e os `problems` são testáveis sem banco.
export function buildOrderView({
  active,
  paidOrders,
  carts: allCarts,
  participants: people,
  items: itemRows,
  payments: paymentRows,
  now,
}: OrderViewRows): OrderView {
  const awaitingFinalization = paidOrders.map((o) => ({
    order_id: o.id,
    carts: allCarts
      .filter((c) => c.orderId === o.id)
      .map((c) => ({
        ifood_cart_id: c.ifoodCartId,
        restaurant: cartLabel(c),
      })),
  }));

  if (!active) {
    return {
      order: null,
      hint: 'Não há pedido em andamento. Ele é criado ao cadastrar participantes ou carrinhos.',
      awaiting_finalization: awaitingFinalization,
    };
  }

  const nameById = new Map(people.map((p) => [p.id, p.name]));
  const cartRows = allCarts.filter((c) => c.orderId === active.id);
  const problems: string[] = [];
  const preview: Array<Record<string, string>> = [];

  const cartViews = [];
  for (const cart of cartRows) {
    const items = itemRows.filter((i) => i.cartId === cart.id);
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
