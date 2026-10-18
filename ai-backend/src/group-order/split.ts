import { GroupOrderError } from './group-order.errors.js';

// Divide `totalCents` (pode ser negativo, ex.: desconto) proporcionalmente a `weights`,
// pelo método do maior resto: a soma do resultado é SEMPRE exatamente `totalCents`.
// Empates no resto vão para o menor índice, então o resultado é determinístico.
// Com todos os pesos zerados, divide igualmente.
export function allocateProportional(
  totalCents: number,
  weights: number[],
): number[] {
  if (weights.length === 0) return [];
  const sign = totalCents < 0 ? -1 : 1;
  const abs = Math.abs(totalCents);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const w = weightSum > 0 ? weights : weights.map(() => 1);
  const denominator = weightSum > 0 ? weightSum : weights.length;

  // Aritmética inteira exata (os produtos ficam abaixo de 2^53 com os limites de money.ts).
  const exact = w.map((x) => abs * x);
  const base = exact.map((p) => (p - (p % denominator)) / denominator);
  const fractions = exact.map((p) => p % denominator);

  const remainder = abs - base.reduce((a, b) => a + b, 0);
  const byLargestFraction = fractions
    .map((fraction, index) => ({ fraction, index }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let k = 0; k < remainder; k++) base[byLargestFraction[k].index] += 1;

  // `cents !== 0`: evita devolver -0 quando o total é negativo.
  return base.map((cents) => (sign < 0 && cents !== 0 ? -cents : cents));
}

export interface SplitItem {
  priceCents: number;
  quantity: number;
  payerId: number | null;
  name: string;
}

export interface PayerAmount {
  payerId: number;
  itemsCents: number;
  feesCents: number;
  amountCents: number;
}

// Quanto cada pagador deve num carrinho: os itens dele + a fatia proporcional das taxas/descontos
// (total - subtotal). Garante soma == total do carrinho.
export function splitCart(
  items: SplitItem[],
  subtotalCents: number,
  totalCents: number,
): PayerAmount[] {
  const unassigned = items.filter((item) => item.payerId === null);
  if (unassigned.length > 0) {
    throw new GroupOrderError(
      `Itens sem pagador: ${unassigned.map((i) => i.name).join(', ')}.`,
    );
  }

  const itemsTotal = items.reduce((a, i) => a + i.priceCents * i.quantity, 0);
  if (itemsTotal !== subtotalCents) {
    throw new GroupOrderError(
      `A soma dos itens (${itemsTotal / 100}) não bate com o subtotal do carrinho (${subtotalCents / 100}). ` +
        'Releia o carrinho no iFood e registre de novo com group_sync_cart usando o preço unitário final de cada item.',
    );
  }

  const byPayer = new Map<number, number>();
  for (const item of items) {
    const payerId = item.payerId as number;
    byPayer.set(
      payerId,
      (byPayer.get(payerId) ?? 0) + item.priceCents * item.quantity,
    );
  }
  const payerIds = [...byPayer.keys()].sort((a, b) => a - b);
  const itemsByPayer = payerIds.map((id) => byPayer.get(id) as number);
  const fees = allocateProportional(totalCents - subtotalCents, itemsByPayer);

  return payerIds.map((payerId, i) => ({
    payerId,
    itemsCents: itemsByPayer[i],
    feesCents: fees[i],
    amountCents: itemsByPayer[i] + fees[i],
  }));
}
