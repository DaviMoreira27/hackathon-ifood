import { matchItem, parseMcpCart } from './mcp-cart.js';

// Exemplo da documentação do getCart (CartDetailsResponse), com complementos preenchidos.
const CART = {
  cartId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  merchant: {
    merchantId: 'b8f3c1e2-a456-7890-1234-567890abcdef',
    merchantName: 'Pizza Express',
    orderMinimumPrice: 15.0,
    formattedAddress: 'Rua Augusta, 1500 - Consolação, São Paulo',
  },
  items: [
    {
      itemId: 'f7e6d5c4-b3a2-9180-7654-321fedcba098',
      cartItemId: 'd4e5f6a7-0001-4000-c000-000000000001',
      name: 'Margherita Pizza',
      quantity: 2,
      unitPrice: 32.9,
      customerNote: 'sem cebola',
      options: [
        { name: 'Borda recheada', quantity: 1 },
        { groupName: 'Extras', options: [{ optionName: 'Bacon', quantity: 2 }] },
      ],
    },
    {
      itemId: 'a1b2c3d4-0001-4000-8000-000000005103',
      cartItemId: 'd4e5f6a7-0001-4000-c000-000000000002',
      name: 'Coca-Cola 350ml',
      quantity: 1,
      unitPrice: 6.5,
      customerNote: null,
      options: [],
    },
  ],
  deliveryAddress: {
    streetName: 'Rua Augusta',
    streetNumber: '1234',
    neighborhood: 'Consolação',
  },
  deliveryMethod: {
    deliveryMethodMode: 'DELIVERY',
    fee: 5.9,
    estimatedMinutes: { min: 30, max: 45 },
  },
  summary: { totalAmount: 78.2 },
};

describe('parseMcpCart', () => {
  it('lê loja, itens, complementos, prazo e endereço do CartDetailsResponse', () => {
    const info = parseMcpCart(JSON.stringify(CART));
    expect(info).toEqual({
      merchantName: 'Pizza Express',
      eta: 'Hoje, 30 - 45min',
      address: {
        street: 'Rua Augusta, 1234',
        district: 'Consolação',
        complement: '',
      },
      items: [
        {
          cartItemId: 'd4e5f6a7-0001-4000-c000-000000000001',
          itemId: 'f7e6d5c4-b3a2-9180-7654-321fedcba098',
          name: 'Margherita Pizza',
          customerNote: 'sem cebola',
          options: [
            { name: 'Borda recheada', quantity: 1 },
            { name: 'Bacon', quantity: 2 },
          ],
        },
        {
          cartItemId: 'd4e5f6a7-0001-4000-c000-000000000002',
          itemId: 'a1b2c3d4-0001-4000-8000-000000005103',
          name: 'Coca-Cola 350ml',
          customerNote: null,
          options: [],
        },
      ],
    });
  });

  it('tolera campos ausentes e texto que não é JSON', () => {
    expect(parseMcpCart('Carrinho não encontrado')).toBeNull();
    expect(parseMcpCart('[]')).toBeNull();
    expect(parseMcpCart('{"items": [{"name": "X"}]}')).toEqual({
      merchantName: null,
      eta: null,
      address: null,
      items: [
        { cartItemId: '', itemId: '', name: 'X', customerNote: null, options: [] },
      ],
    });
  });

  it('casa o item do banco pelo cartItemId ou pelo itemId', () => {
    const info = parseMcpCart(JSON.stringify(CART))!;
    expect(
      matchItem(info, 'd4e5f6a7-0001-4000-c000-000000000002')?.name,
    ).toBe('Coca-Cola 350ml');
    expect(
      matchItem(info, 'f7e6d5c4-b3a2-9180-7654-321fedcba098')?.name,
    ).toBe('Margherita Pizza');
    expect(matchItem(info, 'outro')).toBeNull();
  });
});
