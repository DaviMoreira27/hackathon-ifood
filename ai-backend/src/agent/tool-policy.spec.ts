import { requiresConfirmation } from './tool-policy.js';
import { resetAppConfig } from '../config/app-config.js';

// Todas as ferramentas do MCP do iFood (documentação do portal).
const READS = [
  'getUser',
  'listAddresses',
  'listItemTaxonomy',
  'searchOffers',
  'browseOffers',
  'getRecommendations',
  'getMerchant',
  'getItem',
  'getCart',
  'getCartDeliveryMethods',
  'listVouchers',
  'listPaymentMethods',
  'trackOrder',
  'getOrder',
];
const CART_EDITS = [
  'createCart',
  'addItemToCart',
  'updateCartItem',
  'removeItemFromCart',
  'setVoucher',
  'removeVoucher',
  'setCartDelivery',
  'setCartPayment',
];

describe('requiresConfirmation (nomes reais do MCP do iFood)', () => {
  beforeEach(() => {
    delete process.env.MCP_CONFIRM_TOOLS;
    resetAppConfig();
  });

  it('exige confirmação para o que cobra ou grava dados permanentes', () => {
    expect(requiresConfirmation('submitOrder')).toBe(true);
    expect(requiresConfirmation('createAddress')).toBe(true);
  });

  it('não incomoda o usuário com leituras (mesmo as que citam address/payment no nome)', () => {
    for (const name of READS)
      expect(requiresConfirmation(name), name).toBe(false);
  });

  it('não pede confirmação para montar o carrinho (inclusive escolher a forma de pagamento)', () => {
    for (const name of CART_EDITS)
      expect(requiresConfirmation(name), name).toBe(false);
  });

  it('ferramentas desconhecidas que parecem fechar pedido ou mexer em endereço pedem confirmação', () => {
    for (const name of [
      'placeOrder',
      'place_order',
      'checkout',
      'payOrder',
      'updateAddress',
      'deleteAddress',
    ]) {
      expect(requiresConfirmation(name), name).toBe(true);
    }
  });

  it('readOnlyHint do servidor vence a heurística de nome', () => {
    expect(requiresConfirmation('payOrder', { readOnlyHint: true })).toBe(
      false,
    );
    expect(requiresConfirmation('payOrder', { readOnlyHint: false })).toBe(
      true,
    );
  });

  it('MCP_CONFIRM_TOOLS substitui as regras', () => {
    process.env.MCP_CONFIRM_TOOLS = 'setCartPayment, removeItemFromCart';
    resetAppConfig();
    expect(requiresConfirmation('setCartPayment')).toBe(true);
    expect(requiresConfirmation('removeItemFromCart')).toBe(true);
    expect(requiresConfirmation('submitOrder')).toBe(false);
  });
});
