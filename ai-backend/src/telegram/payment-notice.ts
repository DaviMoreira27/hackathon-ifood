import { formatBRL } from '../group-order/money.js';
import type { PaymentApplied } from '../payments/payments.service.js';

// Mensagem enviada ao dono do pedido quando um pagamento é confirmado (Markdown do bot).
export function formatPaymentNotice(applied: PaymentApplied): string {
  const where = applied.restaurantName ? ` (${applied.restaurantName})` : '';
  const lines = [
    `✅ **${applied.participantName}** pagou ${formatBRL(applied.amountCents)}${where}.`,
  ];
  if (applied.orderPaid) {
    lines.push(
      '',
      '🎉 **Todos os pagamentos foram confirmados!** Me diga "finalizar pedido" e eu concluo no iFood.',
    );
  } else {
    if (applied.cartPaid && applied.restaurantName) {
      lines.push(`O carrinho de ${applied.restaurantName} já está pago.`);
    }
    if (applied.pendingParticipants.length) {
      lines.push(`Faltam: ${applied.pendingParticipants.join(', ')}.`);
    }
  }
  return lines.join('\n');
}
