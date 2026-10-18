import { comparePrices } from './price-tools.js';

describe('comparePrices', () => {
  it('ordena pelo custo real (item + entrega − desconto) e mostra a economia', () => {
    const out = comparePrices({
      options: [
        {
          label: 'Pizza G',
          restaurant: 'Loja A',
          unit_price: 39.9,
          delivery_fee: 12,
        },
        {
          label: 'Pizza G',
          restaurant: 'Loja B',
          unit_price: 44.9,
          delivery_fee: 0,
        },
        {
          label: 'Combo',
          restaurant: 'Loja C',
          unit_price: 49.9,
          discount: 10,
        },
      ],
    });

    expect(out.split('\n')).toEqual([
      '1. Combo — Loja C: total R$ 39,90 · entrega grátis · economia de R$ 12,00',
      '2. Pizza G — Loja B: total R$ 44,90 · entrega grátis · economia de R$ 7,00',
      '3. Pizza G — Loja A: total R$ 51,90 · inclui entrega R$ 12,00',
      'Mais em conta: Combo (Loja C).',
    ]);
  });

  it('calcula por pessoa e respeita o orçamento', () => {
    const out = comparePrices({
      people: 3,
      budget_per_person: 20,
      options: [
        {
          label: 'Pizza',
          restaurant: 'A',
          unit_price: 30,
          quantity: 2,
          delivery_fee: 5,
        },
        { label: 'Esfirras', restaurant: 'B', unit_price: 2.5, quantity: 20 },
      ],
    });

    expect(out).toContain('Esfirras — B: total R$ 50,00 · R$ 16,67/pessoa');
    expect(out).toContain('Pizza — A: total R$ 65,00 · R$ 21,67/pessoa');
    expect(out).toContain('ACIMA do orçamento');
    expect(out).toContain('Mais em conta dentro do orçamento: Esfirras (B).');
  });

  it('recusa valores inválidos em vez de chutar', () => {
    expect(() =>
      comparePrices({
        options: [{ label: 'x', restaurant: 'y', unit_price: 'caro' }],
      }),
    ).toThrow(/unit_price/);
    expect(() =>
      comparePrices({
        options: [{ label: 'x', restaurant: 'y', unit_price: 10.999 }],
      }),
    ).toThrow(/2 casas/);
    expect(() => comparePrices({ options: [] })).toThrow();
  });

  it('avisa quando a opção não atinge o pedido mínimo e não a recomenda', () => {
    const out = comparePrices({
      options: [
        { label: 'Refri', restaurant: 'A', unit_price: 6, minimum_order: 15 },
        { label: 'Lanche', restaurant: 'B', unit_price: 18, delivery_fee: 3 },
      ],
    });

    expect(out).toContain(
      'Refri — A: total R$ 6,00 · entrega grátis · economia de R$ 15,00 · NÃO atinge o pedido mínimo (faltam R$ 9,00)',
    );
    expect(out).toContain('Mais em conta: Lanche (B).');
  });
});
