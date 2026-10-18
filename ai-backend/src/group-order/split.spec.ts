import { GroupOrderError } from './group-order.errors.js';
import { formatBRL, fromCents, toCents } from './money.js';
import { allocateProportional, splitCart } from './split.js';

describe('money', () => {
  it('converte reais em centavos sem erro de ponto flutuante', () => {
    expect(toCents(19.9)).toBe(1990);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents('42.90')).toBe(4290);
    expect(toCents(0)).toBe(0);
    expect(toCents(-5)).toBe(-500);
  });

  it('rejeita valores inválidos em vez de arredondar', () => {
    expect(() => toCents(10.999)).toThrow(GroupOrderError);
    expect(() => toCents(NaN)).toThrow(GroupOrderError);
    expect(() => toCents(Infinity)).toThrow(GroupOrderError);
    expect(() => toCents('abc')).toThrow(GroupOrderError);
    expect(() => toCents(1_000_000)).toThrow(GroupOrderError);
  });

  it('formata para o banco e para o usuário', () => {
    expect(fromCents(4290)).toBe('42.90');
    expect(fromCents(5)).toBe('0.05');
    expect(fromCents(-250)).toBe('-2.50');
    expect(formatBRL(4290)).toBe('R$ 42,90');
    expect(formatBRL(123456789 % 10_000_000)).toBe('R$ 34.567,89');
    expect(formatBRL(5)).toBe('R$ 0,05');
  });
});

describe('allocateProportional', () => {
  it('divide proporcionalmente', () => {
    expect(allocateProportional(500, [3000, 1000])).toEqual([375, 125]);
  });

  it('distribui os centavos que sobram pelo maior resto, com desempate estável', () => {
    expect(allocateProportional(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(allocateProportional(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateProportional(2, [1, 1, 1])).toEqual([1, 1, 0]);
  });

  it('aceita total negativo (desconto) e pesos zerados', () => {
    expect(allocateProportional(-500, [3000, 1000])).toEqual([-375, -125]);
    expect(allocateProportional(-1, [1, 1])).toEqual([-1, 0]);
    expect(allocateProportional(300, [0, 0, 0])).toEqual([100, 100, 100]);
    expect(allocateProportional(0, [5, 7])).toEqual([0, 0]);
    expect(allocateProportional(100, [])).toEqual([]);
  });

  it('a soma é sempre exatamente o total (fuzz)', () => {
    let seed = 12345;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let run = 0; run < 5000; run++) {
      const total = rand(200_001) - 100_000;
      const weights = Array.from({ length: 1 + rand(6) }, () => rand(500_000));
      const result = allocateProportional(total, weights);

      expect(result.reduce((a, b) => a + b, 0)).toBe(total);
      const sum = weights.reduce((a, b) => a + b, 0);
      result.forEach((value, i) => {
        const ideal =
          sum > 0 ? (total * weights[i]) / sum : total / weights.length;
        expect(Math.abs(value - ideal)).toBeLessThan(1);
      });
    }
  });
});

describe('splitCart', () => {
  const item = (
    name: string,
    price: number,
    qty: number,
    payerId: number | null,
  ) => ({
    name,
    priceCents: price,
    quantity: qty,
    payerId,
  });

  it('um pagador paga o carrinho inteiro, com taxas', () => {
    const result = splitCart([item('Pizza', 4290, 1, 7)], 4290, 4790);
    expect(result).toEqual([
      { payerId: 7, itemsCents: 4290, feesCents: 500, amountCents: 4790 },
    ]);
  });

  it('divide as taxas proporcionalmente ao valor dos itens de cada pagador', () => {
    const result = splitCart(
      [
        item('Pizza', 3000, 1, 2),
        item('Refri', 500, 2, 1),
        item('Suco', 0, 1, 1),
      ],
      4000,
      4500,
    );
    expect(result).toEqual([
      { payerId: 1, itemsCents: 1000, feesCents: 125, amountCents: 1125 },
      { payerId: 2, itemsCents: 3000, feesCents: 375, amountCents: 3375 },
    ]);
    expect(result.reduce((a, r) => a + r.amountCents, 0)).toBe(4500);
  });

  it('desconto maior que a taxa reduz o valor de cada um', () => {
    const result = splitCart(
      [item('A', 2000, 1, 1), item('B', 2000, 1, 2)],
      4000,
      3600,
    );
    expect(result.map((r) => r.amountCents)).toEqual([1800, 1800]);
  });

  it('recusa item sem pagador', () => {
    expect(() => splitCart([item('Pizza', 1000, 1, null)], 1000, 1000)).toThrow(
      /sem pagador: Pizza/,
    );
  });

  it('recusa subtotal que não bate com a soma dos itens', () => {
    expect(() => splitCart([item('Pizza', 1000, 2, 1)], 1500, 1500)).toThrow(
      /não bate com o subtotal/,
    );
  });
});
