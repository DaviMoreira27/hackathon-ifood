import { progressLabel } from './progress.js';

describe('progressLabel', () => {
  it('escolhe a etapa pelo nome das ferramentas', () => {
    expect(progressLabel(['searchOffers'])).toBe('Buscando ofertas...');
    expect(progressLabel(['getMerchant', 'getItem'])).toBe(
      'Olhando o cardápio...',
    );
    expect(progressLabel(['getCart'])).toBe('Conferindo o carrinho...');
    expect(progressLabel(['group_add_participant'])).toBe(
      'Organizando o pedido em grupo...',
    );
  });

  it('no lote misto vale a etapa mais importante', () => {
    expect(progressLabel(['getItem', 'addItemToCart'])).toBe(
      'Montando o carrinho...',
    );
    expect(progressLabel(['getCart', 'submitOrder'])).toBe(
      'Enviando o pedido...',
    );
  });

  it('ferramenta desconhecida tem um rótulo genérico; nenhuma, nenhum', () => {
    expect(progressLabel(['xyz'])).toBe('Consultando o iFood...');
    expect(progressLabel([])).toBeNull();
  });
});
