import { GroupOrderError } from './group-order.errors.js';
import type { GroupOrderService } from './group-order.service.js';
import { GROUP_TOOLS, GroupOrderTools } from './group-order.tools.js';
import { resetAppConfig } from '../config/app-config.js';

const CTX = { chatId: 10, userId: 7 };

describe('GroupOrderTools', () => {
  let orders: Record<string, ReturnType<typeof vi.fn>>;
  let tools: GroupOrderTools;

  beforeEach(() => {
    delete process.env.MCP_CHECKOUT_TOOL_PATTERN;
    resetAppConfig();
    orders = {
      getOrderView: vi.fn(),
      addParticipant: vi.fn(),
      syncCart: vi.fn(),
      assignPayer: vi.fn(),
      confirmOrder: vi.fn(),
      reopenOrder: vi.fn(),
      cancelOrder: vi.fn(),
      markFinalized: vi.fn(),
      hasPaidOrder: vi.fn().mockResolvedValue(false),
      openIfoodCartIds: vi.fn().mockResolvedValue([]),
    };
    tools = new GroupOrderTools(orders as unknown as GroupOrderService);
  });

  describe('definições', () => {
    it('todas têm nome único com prefixo group_ e um JSON schema de objeto', () => {
      const names = GROUP_TOOLS.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
      for (const tool of GROUP_TOOLS) {
        expect(tool.name).toMatch(/^group_[a-z_]+$/);
        expect(tool.input_schema.type).toBe('object');
        expect(tool.description).toBeTruthy();
      }
      expect(tools.has('group_confirm_order')).toBe(true);
      expect(tools.has('search_offers')).toBe(false);
    });

    it('os campos obrigatórios existem nas propriedades', () => {
      for (const tool of GROUP_TOOLS) {
        const { properties = {}, required = [] } = tool.input_schema as {
          properties?: Record<string, unknown>;
          required?: string[];
        };
        for (const field of required) expect(properties).toHaveProperty(field);
      }
    });
  });

  describe('mergeTools', () => {
    const mcp = [
      { name: 'search' },
      { name: 'cart_checkout' },
      { name: 'Checkout_Order' },
    ] as never[];

    it('mantém o checkout sempre na lista (a trava é checkMcpCall)', () => {
      const merged = tools.mergeTools(mcp).map((t) => t.name);
      expect(merged).toEqual(
        expect.arrayContaining([
          'search',
          'cart_checkout',
          'Checkout_Order',
          'group_get_order',
        ]),
      );
    });

    it('reconhece o envio do pedido do iFood (submitOrder) e só ele', () => {
      for (const name of ['submitOrder', 'SubmitOrder', 'submit_order']) {
        expect(tools.isCheckoutTool(name), name).toBe(true);
      }
      for (const name of [
        'createCart',
        'getCart',
        'setCartDelivery',
        'listPaymentMethods',
        'setCartPayment',
        'trackOrder',
        'getOrder',
        'searchOffers',
        'createAddress',
      ]) {
        expect(tools.isCheckoutTool(name), name).toBe(false);
      }
    });

    it('o padrão do checkout é configurável', () => {
      process.env.MCP_CHECKOUT_TOOL_PATTERN = '^finish_';
      resetAppConfig();
      expect(tools.isCheckoutTool('finish_order')).toBe(true);
      expect(tools.isCheckoutTool('cart_checkout')).toBe(false);
    });

    it('valor vazio usa o padrão (e casa o submitOrder)', () => {
      process.env.MCP_CHECKOUT_TOOL_PATTERN = '';
      resetAppConfig();
      expect(tools.isCheckoutTool('submitOrder')).toBe(true);
      expect(tools.isCheckoutTool('getCart')).toBe(false);
    });

    it('ferramenta do MCP com nome reservado é descartada', () => {
      const merged = tools.mergeTools([
        { name: 'group_get_order', description: 'impostor' },
      ] as never[]);
      expect(merged.filter((t) => t.name === 'group_get_order')).toHaveLength(
        1,
      );
      expect(
        merged.find((t) => t.name === 'group_get_order')?.description,
      ).not.toBe('impostor');
    });
  });

  describe('checkMcpCall (trava do checkout)', () => {
    it('não interfere em ferramentas que não são de checkout', async () => {
      expect(
        await tools.checkMcpCall(CTX, 'search_offers', { q: 'pizza' }),
      ).toBeNull();
      expect(orders.hasPaidOrder).not.toHaveBeenCalled();
    });

    it('bloqueia o checkout sem pedido pago', async () => {
      expect(await tools.checkMcpCall(CTX, 'cart_checkout', {})).toMatch(
        /não foi totalmente pago/,
      );
    });

    it('com pedido pago, libera o carrinho pago mas bloqueia quem cita um carrinho em aberto', async () => {
      orders.hasPaidOrder.mockResolvedValue(true);
      orders.openIfoodCartIds.mockResolvedValue(['cart-novo']);

      expect(
        await tools.checkMcpCall(CTX, 'cart_checkout', { cartId: 'cart-pago' }),
      ).toBeNull();
      expect(
        await tools.checkMcpCall(CTX, 'cart_checkout', {
          nested: { cartId: 'cart-novo' },
        }),
      ).toMatch(/carrinho cart-novo ainda não foi pago/);
    });
  });

  describe('execute', () => {
    it('devolve o resultado como JSON', async () => {
      orders.getOrderView.mockResolvedValue({ order: null });
      expect(await tools.execute('group_get_order', {}, CTX)).toEqual({
        text: '{"order":null}',
        isError: false,
      });
      expect(orders.getOrderView).toHaveBeenCalledWith(7);
    });

    it('transforma erro de negócio em resultado de erro com a mensagem', async () => {
      orders.assignPayer.mockRejectedValue(
        new GroupOrderError('Ana já paga o carrinho X'),
      );
      const result = await tools.execute(
        'group_assign_payer',
        { ifood_cart_id: 'c', item_id: 'i', participant_name: 'Ana' },
        CTX,
      );
      expect(result).toEqual({
        text: 'Ana já paga o carrinho X',
        isError: true,
      });
    });

    it('erro inesperado não vaza detalhes internos', async () => {
      orders.getOrderView.mockRejectedValue(
        new Error('SELECT * FROM users WHERE senha...'),
      );
      const result = await tools.execute('group_get_order', {}, CTX);
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain('SELECT');
    });

    it('valida a entrada antes de chamar o serviço', async () => {
      const bad = [
        ['group_add_participant', {}],
        ['group_add_participant', { name: 42 }],
        ['group_assign_payer', { ifood_cart_id: 'c', item_id: 'i' }],
        [
          'group_sync_cart',
          {
            ifood_cart_id: 'c',
            restaurant_name: 'R',
            subtotal: '10',
            total: 10,
            items: [],
          },
        ],
        [
          'group_sync_cart',
          {
            ifood_cart_id: 'c',
            restaurant_name: 'R',
            subtotal: 10,
            total: 10,
            items: 'x',
          },
        ],
        [
          'group_sync_cart',
          {
            ifood_cart_id: 'c',
            restaurant_name: 'R',
            subtotal: 10,
            total: 10,
            items: [{ item_id: 'i', name: 'N', unit_price: 10, quantity: 1.5 }],
          },
        ],
        ['group_mark_finalized', { order_id: 'abc' }],
      ] as const;
      for (const [name, input] of bad) {
        const result = await tools.execute(name, input, CTX);
        expect(result.isError, name).toBe(true);
      }
      expect(orders.addParticipant).not.toHaveBeenCalled();
      expect(orders.assignPayer).not.toHaveBeenCalled();
      expect(orders.syncCart).not.toHaveBeenCalled();
      expect(orders.markFinalized).not.toHaveBeenCalled();
    });

    it('converte os nomes snake_case do LLM para o serviço', async () => {
      orders.syncCart.mockResolvedValue({});
      await tools.execute(
        'group_sync_cart',
        {
          ifood_cart_id: 'c1',
          restaurant_name: 'Pizzaria',
          subtotal: 40,
          total: 45,
          items: [{ item_id: 'p', name: 'Pizza', unit_price: 40, quantity: 1 }],
        },
        CTX,
      );
      expect(orders.syncCart).toHaveBeenCalledWith(7, {
        ifoodCartId: 'c1',
        restaurantName: 'Pizzaria',
        subtotal: 40,
        total: 45,
        items: [{ itemId: 'p', name: 'Pizza', unitPrice: 40, quantity: 1 }],
      });
    });

    it('confirmar: anexa os links e manda o LLM não repeti-los', async () => {
      orders.confirmOrder.mockResolvedValue({
        alreadyConfirmed: false,
        payments: [
          {
            participant: 'Ana',
            restaurant: 'Pizzaria',
            amount: 'R$ 33,75',
            status: 'pending',
          },
        ],
        links: [
          {
            participant: 'Ana',
            restaurant: 'Pizzaria',
            amount: 'R$ 33,75',
            url: 'http://localhost:5173/pay/tok_1',
          },
        ],
        failed: [],
      });

      const result = await tools.execute('group_confirm_order', {}, CTX);

      expect(result.isError).toBe(false);
      expect(result.appendix).toContain(
        '[abrir pagamento](http://localhost:5173/pay/tok_1)',
      );
      expect(result.appendix).toContain('Ana — R$ 33,75 (Pizzaria)');
      const body = JSON.parse(result.text);
      expect(body.links_attached).toBe(1);
      expect(body.note).toContain('NÃO os escreva');
      expect(result.text).not.toContain('localhost:5173'); // o LLM nem recebe a URL
    });

    it('confirmar com link que falhou: informa o LLM e não anexa nada vazio', async () => {
      orders.confirmOrder.mockResolvedValue({
        alreadyConfirmed: false,
        payments: [],
        links: [],
        failed: ['Bia'],
      });

      const result = await tools.execute('group_confirm_order', {}, CTX);

      expect(result.appendix).toBeUndefined();
      expect(JSON.parse(result.text).note).toContain(
        'Não consegui gerar o link de: Bia',
      );
    });

    it('ferramenta desconhecida é erro', async () => {
      expect((await tools.execute('group_nada', {}, CTX)).isError).toBe(true);
    });
  });
});
