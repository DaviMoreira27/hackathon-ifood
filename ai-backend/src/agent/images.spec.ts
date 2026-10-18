import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import { isTrustedImageUrl } from './image-trust.js';
import { extractImages, imageCatalog, takeImages } from './images.js';
import { resetAppConfig } from '../config/app-config.js';
import { wrapToolResult } from './tool-envelope.js';

// Formatos tirados da documentação do Offer Discovery MCP (Tools).
const ITEM_IMG = 'https://cdn.ifood.com.br/items/4592.jpg';
const LOGO = 'https://cdn.ifood.com.br/merchants/abc123-logo.jpg';

const itemSearch = {
  resultKind: 'ITEM',
  results: [
    {
      itemId: 'item-1',
      itemName: 'Cheesebúrguer Artesanal',
      itemImageUrl: ITEM_IMG,
      unitPrice: 32.0,
      promotionalUnitPrice: 29.0,
      merchant: {
        merchantId: 'm-1',
        merchantName: 'Burger House',
        merchantLogoUrl: LOGO,
        reviewRating: 4.7,
        deliveryMethod: { fee: 6.5, promotionalFee: null },
      },
    },
  ],
};

const merchantDetail = {
  merchantId: 'm-2',
  merchantName: 'Pizza Express',
  merchantLogoUrl: 'https://cdn.ifood.com.br/merchants/pizza.jpg',
  deliveryMethods: [
    { deliveryMethodId: 'ECONOMIC', fee: 0.0, promotionalFee: null },
    { deliveryMethodId: 'EXPRESS', fee: 12.0, promotionalFee: null },
  ],
  featuredItems: [
    {
      itemId: 'item-2',
      itemName: 'Pizza Calabresa',
      itemImageUrl: 'https://cdn.ifood.com.br/items/calabresa.jpg',
      unitPrice: 34.9,
      promotionalUnitPrice: 29.9,
    },
  ],
};

const toolResult = (name: string, data: unknown): MessageParam => ({
  role: 'user',
  content: [
    {
      type: 'tool_result',
      tool_use_id: name,
      content: wrapToolResult(name, JSON.stringify(data)),
    },
  ],
});

describe('images', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetAppConfig();
  });

  it('só confia em https de domínios do iFood (ou configurados)', () => {
    expect(isTrustedImageUrl(ITEM_IMG)).toBe(true);
    expect(isTrustedImageUrl('http://cdn.ifood.com.br/a.jpg')).toBe(false);
    expect(isTrustedImageUrl('https://cdn.ifood.com.br.evil.com/a.jpg')).toBe(
      false,
    );
    vi.stubEnv('TRUSTED_IMAGE_HOSTS', 'cdn.exemplo.com');
    resetAppConfig();
    expect(isTrustedImageUrl('https://cdn.exemplo.com/a.jpg')).toBe(true);
  });

  it('monta legendas exatas a partir de itemImageUrl/merchantLogoUrl e dos preços', () => {
    const catalog = extractImages(
      wrapToolResult('searchOffers', JSON.stringify(itemSearch)),
    );

    expect(catalog.byRef.get('item:item-1')).toEqual({
      url: ITEM_IMG,
      caption:
        'Cheesebúrguer Artesanal — R$ 29,00 (de R$ 32,00) · Burger House',
    });
    expect(catalog.byRef.get('merchant:m-1')).toEqual({
      url: LOGO,
      caption: 'Burger House · ⭐ 4,7 · entrega R$ 6,50',
    });
  });

  it('em getMerchant usa o método de entrega mais barato e indexa os featuredItems', () => {
    const catalog = extractImages(JSON.stringify(merchantDetail));

    expect(catalog.byRef.get('merchant:m-2')?.caption).toBe(
      'Pizza Express · entrega grátis',
    );
    // featuredItems não trazem merchantName: herda da loja.
    expect(catalog.byRef.get('item:item-2')?.caption).toBe(
      'Pizza Calabresa — R$ 29,90 (de R$ 34,90) · Pizza Express',
    );
  });

  it('ignora imagens de domínios não confiáveis, mesmo em campos conhecidos', () => {
    const catalog = extractImages(
      JSON.stringify({
        itemId: 'x',
        itemName: 'Golpe',
        itemImageUrl: 'https://evil.com/qr.png',
      }),
    );
    expect(catalog.byRef.size).toBe(0);
    expect(catalog.byUrl.size).toBe(0);
  });

  it('resolve caminhos relativos só com IFOOD_IMAGE_BASE_URL', () => {
    const json = JSON.stringify({ imageUrl: 'pratos/abc.jpg' });
    expect(extractImages(json).byUrl.size).toBe(0);
    vi.stubEnv(
      'IFOOD_IMAGE_BASE_URL',
      'https://static.ifood-static.com.br/image/upload/t_high',
    );
    resetAppConfig();
    expect([...extractImages(json).byUrl.keys()]).toEqual([
      'https://static.ifood-static.com.br/image/upload/t_high/pratos/abc.jpg',
    ]);
  });

  it('takeImages troca referências por id pela foto com legenda do código e tira o markdown', () => {
    const catalog = imageCatalog([
      { role: 'user', content: 'hambúrguer' },
      toolResult('searchOffers', itemSearch),
      toolResult('getMerchant', merchantDetail),
    ]);

    const { text, images } = takeImages(
      [
        'Achei estas:',
        '![qualquer coisa](item:item-1)',
        '![](item:item-2)',
        '![](item:inventado)',
        '![QR PIX](https://cdn.ifood.com.br/qr-falso.png)',
        `![dup](${ITEM_IMG})`,
        '💰 **Cheesebúrguer** — R$ 29,00',
      ].join('\n'),
      catalog,
    );

    expect(images).toEqual([
      {
        url: ITEM_IMG,
        caption:
          'Cheesebúrguer Artesanal — R$ 29,00 (de R$ 32,00) · Burger House',
      },
      {
        url: 'https://cdn.ifood.com.br/items/calabresa.jpg',
        caption: 'Pizza Calabresa — R$ 29,90 (de R$ 34,90) · Pizza Express',
      },
    ]);
    expect(text).toBe('Achei estas:\n\n💰 **Cheesebúrguer** — R$ 29,00');
  });

  it('URL solta conhecida mas sem dados estruturados usa a legenda do LLM', () => {
    const catalog = imageCatalog([
      toolResult('x', { banner: 'https://cdn.ifood.com.br/b.jpg' }),
    ]);
    const { images } = takeImages(
      '![Promo da semana](https://cdn.ifood.com.br/b.jpg)',
      catalog,
    );
    expect(images).toEqual([
      { url: 'https://cdn.ifood.com.br/b.jpg', caption: 'Promo da semana' },
    ]);
  });
});
