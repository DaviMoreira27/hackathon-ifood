import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import { comparePrices } from './compare-prices.js';
import { priceFacts } from './price-facts.js';
import { wrapToolResult } from './tool-envelope.js';

// Conversa com resultados no formato do Offer Discovery MCP.
function conversation(...results: Array<[string, unknown]>): MessageParam[] {
  return results.flatMap(([name, body], i): MessageParam[] => [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${i}`, name, input: {} }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `t${i}`,
          content: wrapToolResult(name, JSON.stringify(body)),
        },
      ],
    },
  ]);
}

const search = {
  items: [
    {
      itemId: 'forno-marg',
      itemName: 'Pizza Margherita',
      unitPrice: 44.9,
      merchantId: 'forno',
      merchantName: 'Forno Express',
      deliveryMethod: { fee: 4.99 },
    },
    {
      itemId: 'rapida-marg',
      itemName: 'Pizza Margherita',
      unitPrice: 47.9,
      merchantId: 'rapida',
      merchantName: 'Pizza Rápida',
      deliveryMethod: { fee: 6, promotionalFee: 0 },
    },
    {
      itemId: 'bella-marg',
      itemName: 'Pizza Margherita',
      unitPrice: 54.9,
      promotionalUnitPrice: 49.9,
      merchantId: 'bella',
      merchantName: 'Bella Napoli',
      deliveryMethod: { fee: 9.9 },
    },
  ],
};
const forno = {
  merchantId: 'forno',
  merchantName: 'Forno Express',
  minimumOrderAmount: 20,
  deliveryMethods: [
    { type: 'ECONOMIC', fee: 4.99, etaMinutes: 55 },
    { type: 'EXPRESS', fee: 9.99, etaMinutes: 25 },
  ],
  featuredItems: [{ itemId: 'forno-refri', itemName: 'Refri', unitPrice: 6 }],
};

describe('compare_prices', () => {
  const facts = priceFacts(
    conversation(['searchOffers', search], ['getMerchant', forno]),
  );

  it('lê preço promocional e taxa promocional do iFood, sem o LLM copiar números', () => {
    const out = comparePrices(
      {
        options: [
          { item_id: 'forno-marg' },
          { item_id: 'rapida-marg' },
          { item_id: 'bella-marg' },
        ],
      },
      facts,
    );

    expect(out.split('\n')).toEqual([
      '1. Pizza Margherita — Pizza Rápida: total R$ 47,90 (item R$ 47,90 + entrega grátis) · economia de R$ 11,90',
      '2. Pizza Margherita — Forno Express: total R$ 49,89 (item R$ 44,90 + entrega R$ 4,99) · economia de R$ 9,91',
      '3. Pizza Margherita — Bella Napoli: total R$ 59,80 (item R$ 49,90 + entrega R$ 9,90)',
      'Mais em conta: Pizza Margherita (Pizza Rápida).',
    ]);
  });

  it('usa a entrega pedida e herda a loja nos destaques do getMerchant', () => {
    const out = comparePrices(
      {
        options: [
          { item_id: 'forno-marg', delivery_type: 'EXPRESS' },
          { item_id: 'forno-refri', quantity: 2 },
        ],
      },
      facts,
    );

    expect(out).toContain(
      'Pizza Margherita — Forno Express: total R$ 54,89 (item R$ 44,90 + entrega R$ 9,99)',
    );
    expect(out).toContain(
      'Refri — Forno Express: total R$ 16,99 (2x R$ 6,00 + entrega R$ 4,99) · economia de R$ 37,90 · NÃO atinge o pedido mínimo (faltam R$ 8,00)',
    );
    expect(out).toContain('Mais em conta: Pizza Margherita (Forno Express).');
  });

  it('calcula por pessoa e respeita o orçamento', () => {
    const out = comparePrices(
      {
        people: 3,
        budget_per_person: 16,
        options: [{ item_id: 'rapida-marg' }, { item_id: 'bella-marg' }],
      },
      facts,
    );

    expect(out).toContain('R$ 15,97/pessoa');
    expect(out).toContain('R$ 19,94/pessoa');
    expect(out).toContain('ACIMA do orçamento');
    expect(out).toContain(
      'Mais em conta dentro do orçamento: Pizza Margherita (Pizza Rápida).',
    );
  });

  it('pede a consulta que falta em vez de chutar', () => {
    expect(() =>
      comparePrices({ options: [{ item_id: 'inventado' }] }, facts),
    ).toThrow(/searchOffers ou getItem/);
    const semTaxa = priceFacts(
      conversation([
        'getItem',
        { itemId: 'x', itemName: 'X', unitPrice: 10, merchantId: 'm9' },
      ]),
    );
    expect(() =>
      comparePrices({ options: [{ item_id: 'x' }] }, semTaxa),
    ).toThrow(/getMerchant \(merchantId m9\)/);
    expect(() => comparePrices({ options: [] }, facts)).toThrow();
  });
});
