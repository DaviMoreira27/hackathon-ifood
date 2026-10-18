import {
  DEFAULT_CART_SYNC_TOOLS,
  DEFAULT_CHECKOUT_TOOL_PATTERN,
  DEFAULT_WHATSAPP_GRAPH_VERSION,
  loadAppConfig,
} from './app-config.js';

describe('loadAppConfig', () => {
  it('sem nada definido, vale o padrão de cada campo', () => {
    const config = loadAppConfig({});
    expect(config.port).toBe(3000);
    expect(config.mcp.checkoutToolPattern).toBe(DEFAULT_CHECKOUT_TOOL_PATTERN);
    expect(config.mcp.cartSyncTools).toEqual(DEFAULT_CART_SYNC_TOOLS);
    expect(config.mcp.confirmTools).toBeNull();
    expect(config.payments.ttlMinutes).toBe(24 * 60);
    expect(config.trustedImageHosts).toEqual([]);
  });

  it('variável vazia vale o mesmo que ausente', () => {
    const config = loadAppConfig({
      MCP_CHECKOUT_TOOL_PATTERN: '',
      MCP_CART_SYNC_TOOLS: ' ',
      PAYMENT_TTL_MINUTES: '',
    });
    expect(config.mcp.checkoutToolPattern.test('submitOrder')).toBe(true);
    expect(config.mcp.checkoutToolPattern.test('getCart')).toBe(false);
    expect(config.mcp.cartSyncTools).toEqual(DEFAULT_CART_SYNC_TOOLS);
    expect(config.payments.ttlMinutes).toBe(24 * 60);
  });

  it('lê listas, regex e números do ambiente', () => {
    const config = loadAppConfig({
      MCP_CONFIRM_TOOLS: 'submitOrder, createAddress',
      MCP_CHECKOUT_TOOL_PATTERN: '^finish_',
      TRUSTED_IMAGE_HOSTS: 'CDN.example.com, ',
      PAYMENT_TTL_MINUTES: '30',
    });
    expect(config.mcp.confirmTools).toEqual(['submitOrder', 'createAddress']);
    expect(config.mcp.checkoutToolPattern.test('FINISH_order')).toBe(true);
    expect(config.trustedImageHosts).toEqual(['cdn.example.com']);
    expect(config.payments.ttlMinutes).toBe(30);
  });

  it('valor inválido derruba o boot listando todos os erros', () => {
    const load = () =>
      loadAppConfig({
        MCP_CHECKOUT_TOOL_PATTERN: '(',
        PAYMENT_TTL_MINUTES: 'zero',
        PAYMENT_LINK_TEMPLATE: 'http://localhost/pay',
        MCP_SERVER_URL: 'não é url',
      });
    for (const key of [
      'MCP_CHECKOUT_TOOL_PATTERN',
      'PAYMENT_TTL_MINUTES',
      'PAYMENT_LINK_TEMPLATE',
      'MCP_SERVER_URL',
    ]) {
      expect(load, key).toThrow(key);
    }
  });

  it('WhatsApp completo liga o canal com a versão padrão da Graph API', () => {
    const config = loadAppConfig({
      WHATSAPP_ACCESS_TOKEN: 'tok',
      WHATSAPP_PHONE_NUMBER_ID: '123',
      WHATSAPP_VERIFY_TOKEN: 'verifica',
      WHATSAPP_APP_SECRET: 'segredo',
    });
    expect(config.whatsapp).toEqual({
      accessToken: 'tok',
      phoneNumberId: '123',
      verifyToken: 'verifica',
      appSecret: 'segredo',
      graphVersion: DEFAULT_WHATSAPP_GRAPH_VERSION,
    });
    expect(loadAppConfig({}).whatsapp).toBeUndefined();
  });

  it('WhatsApp pela metade derruba o boot dizendo o que falta', () => {
    const load = () =>
      loadAppConfig({
        WHATSAPP_ACCESS_TOKEN: 'tok',
        WHATSAPP_PHONE_NUMBER_ID: '123',
      });
    expect(load).toThrow('WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET');
  });
});
