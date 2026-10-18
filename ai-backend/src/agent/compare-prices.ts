import { GroupOrderError, formatBRL, toCents } from '../group-order/index.js';
import { text as clean, type Obj } from '../common/json.js';
import type { PriceFacts } from './price-facts.js';

// Ferramenta local (não vai ao iFood) para comparar opções encontradas nas buscas. O LLM só
// escolhe as opções (item_id); preço, taxa de entrega e pedido mínimo são lidos pelo código nos
// resultados das ferramentas da conversa, e as contas são feitas em centavos. O LLM nunca
// transcreve número: uma taxa copiada errado mudava a recomendação.
export const MAX_OPTIONS = 15;

const text = (v: unknown) => clean(v, 120);

interface RankedOption {
  label: string;
  restaurant: string;
  quantity: number;
  unitCents: number;
  totalCents: number;
  perPersonCents: number;
  feeCents: number;
  // Quanto falta em itens para atingir o pedido mínimo da loja (0 = atingido ou sem mínimo).
  missingForMinimumCents: number;
}

function resolve(raw: unknown, i: number, facts: PriceFacts) {
  const o = (raw ?? {}) as Obj;
  const itemId = text(o.item_id);
  if (!itemId) throw new GroupOrderError(`item_id ausente na opção ${i + 1}.`);
  const quantity = o.quantity ?? 1;
  if (!Number.isInteger(quantity) || (quantity as number) < 1) {
    throw new GroupOrderError(`quantity inválida na opção ${i + 1}.`);
  }
  const item = facts.items.get(itemId);
  if (!item) {
    throw new GroupOrderError(
      `Não achei preço para o item ${itemId} nos resultados desta conversa. Consulte-o com searchOffers ou getItem e use o itemId exato.`,
    );
  }
  const merchant = item.merchantId
    ? facts.merchants.get(item.merchantId)
    : undefined;
  const restaurant = item.merchantName ?? merchant?.name;
  if (!item.merchantId || !merchant?.fees.length || !restaurant) {
    throw new GroupOrderError(
      `Não sei a taxa de entrega da loja do item ${itemId}. Chame getMerchant${item.merchantId ? ` (merchantId ${item.merchantId})` : ''} antes de comparar.`,
    );
  }
  const type =
    typeof o.delivery_type === 'string' ? o.delivery_type : undefined;
  const fees = type
    ? merchant.fees.filter((f) => f.type === type)
    : merchant.fees;
  if (!fees.length) {
    throw new GroupOrderError(
      `A loja ${restaurant} não tem entrega ${type} nos dados consultados.`,
    );
  }
  return {
    label: item.label,
    restaurant,
    quantity: quantity as number,
    unitCents: item.priceCents,
    feeCents: Math.min(...fees.map((f) => f.cents)),
    minimumCents: merchant.minimumCents ?? 0,
  };
}

export function comparePrices(rawInput: unknown, facts: PriceFacts): string {
  const input = (rawInput ?? {}) as Obj;
  const options = input.options;
  if (!Array.isArray(options) || options.length === 0) {
    throw new GroupOrderError('Informe ao menos uma opção.');
  }
  if (options.length > MAX_OPTIONS) {
    throw new GroupOrderError(`No máximo ${MAX_OPTIONS} opções por vez.`);
  }
  const people = input.people ?? 1;
  if (!Number.isInteger(people) || (people as number) < 1) {
    throw new GroupOrderError('people deve ser um inteiro ≥ 1.');
  }
  const budgetCents =
    input.budget_per_person == null
      ? null
      : toCents(input.budget_per_person as number, 'budget_per_person');

  const ranked: RankedOption[] = options.map((raw, i) => {
    const o = resolve(raw, i, facts);
    const itemsCents = o.unitCents * o.quantity;
    const total = itemsCents + o.feeCents;
    return {
      label: o.label,
      restaurant: o.restaurant,
      quantity: o.quantity,
      unitCents: o.unitCents,
      totalCents: total,
      perPersonCents: Math.ceil(total / (people as number)),
      feeCents: o.feeCents,
      missingForMinimumCents: Math.max(0, o.minimumCents - itemsCents),
    };
  });

  ranked.sort((a, b) => a.totalCents - b.totalCents);
  const priciest = ranked[ranked.length - 1].totalCents;

  const lines = ranked.map((o, i) => {
    const item =
      o.quantity === 1
        ? `item ${formatBRL(o.unitCents)}`
        : `${o.quantity}x ${formatBRL(o.unitCents)}`;
    const parts = [
      `${i + 1}. ${o.label} — ${o.restaurant}: total ${formatBRL(o.totalCents)} (${item} + ${o.feeCents === 0 ? 'entrega grátis' : `entrega ${formatBRL(o.feeCents)}`})`,
    ];
    if (people !== 1) parts.push(`${formatBRL(o.perPersonCents)}/pessoa`);
    if (o.totalCents < priciest) {
      parts.push(`economia de ${formatBRL(priciest - o.totalCents)}`);
    }
    if (o.missingForMinimumCents > 0) {
      parts.push(
        `NÃO atinge o pedido mínimo (faltam ${formatBRL(o.missingForMinimumCents)})`,
      );
    }
    if (budgetCents !== null && o.perPersonCents > budgetCents) {
      parts.push('ACIMA do orçamento');
    }
    return parts.join(' · ');
  });

  // A recomendação só considera opções que dá para pedir (mínimo atingido) e que cabem no orçamento.
  const withinBudget = ranked.filter(
    (o) =>
      o.missingForMinimumCents === 0 &&
      (budgetCents === null || o.perPersonCents <= budgetCents),
  );
  const best = withinBudget[0];
  lines.push(
    best
      ? `Mais em conta${budgetCents !== null ? ' dentro do orçamento' : ''}: ${best.label} (${best.restaurant}).`
      : budgetCents !== null
        ? 'Nenhuma opção cabe no orçamento informado (ou atinge o pedido mínimo).'
        : 'Nenhuma opção atinge o pedido mínimo da loja.',
  );
  return lines.join('\n');
}
