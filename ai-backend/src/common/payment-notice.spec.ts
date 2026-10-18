import type { PaymentApplied } from '../payments/payments.service.js';
import { formatPaymentNotice } from './payment-notice.js';

const base: PaymentApplied = {
  paymentId: 1,
  orderId: 1,
  participantName: 'Ana',
  restaurantName: 'Pizzaria',
  amountCents: 3375,
  cartPaid: false,
  orderPaid: false,
  pendingParticipants: ['Bia', 'Caio'],
  ownerChatId: 10,
};

describe('formatPaymentNotice', () => {
  it('avisa quem pagou e quem falta', () => {
    expect(formatPaymentNotice(base)).toBe(
      '✅ **Ana** pagou R$ 33,75 (Pizzaria).\nFaltam: Bia, Caio.',
    );
  });

  it('avisa quando um carrinho fica completo', () => {
    expect(
      formatPaymentNotice({
        ...base,
        cartPaid: true,
        pendingParticipants: ['Caio'],
      }),
    ).toContain('O carrinho de Pizzaria já está pago.');
  });

  it('quando o pedido inteiro está pago, convida a finalizar', () => {
    const text = formatPaymentNotice({
      ...base,
      cartPaid: true,
      orderPaid: true,
      pendingParticipants: [],
    });
    expect(text).toContain('Todos os pagamentos foram confirmados');
    expect(text).toContain('finalizar pedido');
    expect(text).not.toContain('Faltam');
  });

  it('funciona sem nome de restaurante', () => {
    expect(
      formatPaymentNotice({
        ...base,
        restaurantName: null,
        pendingParticipants: [],
      }),
    ).toBe('✅ **Ana** pagou R$ 33,75.');
  });
});
