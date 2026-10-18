import type { OrderViewRows } from './order-view.js';
import { buildOrderView } from './order-view.js';

const order = (id: number, status: string) =>
  ({ id, ownerUserId: 1, status, createdAt: new Date() }) as never;
const cart = (id: number, orderId: number, subtotal: string, total: string) =>
  ({
    id,
    orderId,
    ifoodCartId: `c${id}`,
    restaurantName: `Loja ${id}`,
    subtotal,
    total,
    status: 'pending',
  }) as never;
const item = (
  id: number,
  cartId: number,
  unitPrice: string,
  payer: number | null,
) =>
  ({
    id,
    cartId,
    ifoodItemId: `i${id}`,
    name: `Item ${id}`,
    unitPrice,
    quantity: 1,
    payerParticipantId: payer,
  }) as never;
const person = (id: number, name: string) =>
  ({ id, orderId: 1, name, nameKey: name.toLowerCase() }) as never;

const rows = (over: Partial<OrderViewRows>): OrderViewRows => ({
  active: order(1, 'collecting'),
  paidOrders: [],
  carts: [],
  participants: [],
  items: [],
  payments: [],
  now: 0,
  ...over,
});

describe('buildOrderView', () => {
  it('sem pedido ativo, mostra só os pagos aguardando envio', () => {
    const view = buildOrderView(
      rows({
        active: undefined,
        paidOrders: [order(9, 'paid')],
        carts: [cart(5, 9, '10.00', '15.00')],
      }),
    );
    expect(view.order).toBeNull();
    expect(view.awaiting_finalization).toEqual([
      { order_id: 9, carts: [{ ifood_cart_id: 'c5', restaurant: 'Loja 5' }] },
    ]);
  });

  it('divide as taxas na prévia proporcionalmente aos itens', () => {
    const view = buildOrderView(
      rows({
        carts: [cart(1, 1, '30.00', '36.00')],
        participants: [person(1, 'Ana'), person(2, 'Bia')],
        items: [item(1, 1, '10.00', 1), item(2, 1, '20.00', 2)],
      }),
    );
    expect(view.amounts_preview).toEqual([
      expect.objectContaining({ participant: 'Ana', total: 'R$ 12,00' }),
      expect.objectContaining({ participant: 'Bia', total: 'R$ 24,00' }),
    ]);
    expect(view.problems).toEqual([]);
  });

  it('aponta item sem pagador, carrinho sem participantes e link expirado', () => {
    const view = buildOrderView(
      rows({
        carts: [cart(1, 1, '10.00', '12.00')],
        items: [item(1, 1, '10.00', null)],
      }),
    );
    expect(view.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Loja 1'),
        'Há carrinhos mas nenhum participante: use group_add_participant.',
      ]),
    );

    const paying = buildOrderView(
      rows({
        active: order(1, 'paying'),
        payments: [
          {
            status: 'pending',
            expiresAt: new Date(1000),
            payUrl: 'https://pay',
            participantName: 'Ana',
            restaurantName: 'Loja 1',
            ifoodCartId: 'c1',
            amount: '12.00',
          },
        ] as never,
        now: 2000,
      }),
    );
    expect(paying.payments?.[0].status).toBe('expired');
    expect(paying.problems?.[0]).toContain('O link de Ana expirou');
  });
});
