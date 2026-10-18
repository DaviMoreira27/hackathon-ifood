import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import {
  cartIdOf,
  getCartArgs,
  parseCart,
  triggersCartSync,
} from './cart-sync.js';
import { wrapToolResult } from './tool-policy.js';

const cartJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    cart: {
      cartId: 'c1',
      merchant: { merchantId: 'm1', merchantName: 'Pizzaria Boa' },
      items: [
        { cartItemId: 'ci1', itemName: 'Pizza G', unitPrice: 40, quantity: 1 },
        {
          cartItemId: 'ci2',
          itemName: 'Refri',
          unitPrice: 6,
          promotionalUnitPrice: 5.5,
          quantity: 2,
        },
      ],
      subtotal: 51,
      deliveryFee: 7.9,
      total: 58.9,
      ...overrides,
    },
  });

describe('cart-sync', () => {
  afterEach(() => {
    delete process.env.MCP_CART_SYNC_TOOLS;
  });

  it('dispara nas alterações de carrinho, não em leituras', () => {
    expect(triggersCartSync('addItemToCart')).toBe(true);
    expect(triggersCartSync('setVoucher')).toBe(true);
    expect(triggersCartSync('getCart')).toBe(false);
    expect(triggersCartSync('createCart')).toBe(false);
    process.env.MCP_CART_SYNC_TOOLS = 'add_item';
    expect(triggersCartSync('add_item')).toBe(true);
    expect(triggersCartSync('addItemToCart')).toBe(false);
  });

  it('acha o cartId no argumento ou no resultado', () => {
    expect(cartIdOf({ cartId: 'c1', itemId: 'i9' }, '')).toBe('c1');
    expect(cartIdOf({}, wrapToolResult('x', '{"cart":{"cartId":"c2"}}'))).toBe(
      'c2',
    );
    expect(cartIdOf({ itemId: 'i9' }, 'texto')).toBeNull();
  });

  it('monta os argumentos do getCart pelo schema anunciado', () => {
    const tool = (props: Record<string, unknown>, required?: string[]) =>
      [
        {
          name: 'getCart',
          input_schema: { type: 'object', properties: props, required },
        },
      ] as Tool[];
    expect(getCartArgs(tool({ cartId: {} }), 'c1')).toEqual({ cartId: 'c1' });
    expect(getCartArgs(tool({ id: {}, x: {} }, ['id']), 'c1')).toEqual({
      id: 'c1',
    });
    expect(getCartArgs(tool({ a: {}, b: {} }), 'c1')).toBeNull();
    expect(getCartArgs([], 'c1')).toBeNull();
  });

  it('lê itens, preços e totais exatamente como o getCart devolveu', () => {
    const parsed = parseCart(wrapToolResult('getCart', cartJson()), 'c1');

    expect(parsed).toEqual({
      ok: true,
      input: {
        ifoodCartId: 'c1',
        restaurantName: 'Pizzaria Boa',
        subtotal: 51,
        total: 58.9,
        items: [
          { itemId: 'ci1', name: 'Pizza G', unitPrice: 40, quantity: 1 },
          { itemId: 'ci2', name: 'Refri', unitPrice: 5.5, quantity: 2 },
        ],
      },
    });
  });

  it('usa o total da linha (com opcionais) quando ele existe', () => {
    const parsed = parseCart(
      cartJson({
        items: [
          {
            cartItemId: 'ci1',
            itemName: 'Pizza G + borda',
            unitPrice: 40,
            totalPrice: 90,
            quantity: 2,
          },
        ],
        subtotal: { value: 90 },
        total: '97.90',
      }),
      'c1',
    );
    expect(parsed.ok && parsed.input.items[0].unitPrice).toBe(45);
    expect(parsed.ok && parsed.input.total).toBe(97.9);
  });

  it('recusa quando a soma dos itens não bate com o subtotal', () => {
    const parsed = parseCart(cartJson({ subtotal: 60 }), 'c1');
    expect(parsed).toMatchObject({ ok: false });
    expect(!parsed.ok && parsed.reason).toContain('não bate');
  });

  it('recusa formatos que não reconhece em vez de adivinhar', () => {
    expect(parseCart('não é json', 'c1')).toMatchObject({ ok: false });
    expect(parseCart('{"foo":1}', 'c1')).toMatchObject({ ok: false });
    expect(
      parseCart(
        cartJson({
          items: [{ itemName: 'Sem id', unitPrice: 1, quantity: 1 }],
        }),
        'c1',
      ),
    ).toMatchObject({ ok: false });
  });

  it('carrinho vazio vira lista vazia (remove do registro)', () => {
    const parsed = parseCart(
      cartJson({ items: [], subtotal: 0, total: 0 }),
      'c1',
    );
    expect(parsed.ok && parsed.input.items).toEqual([]);
  });
});
