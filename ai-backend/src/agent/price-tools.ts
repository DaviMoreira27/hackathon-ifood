import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { GroupOrderError } from '../group-order/group-order.errors.js';
import { formatBRL, toCents } from '../group-order/money.js';

// Ferramenta local (não vai ao iFood) para comparar opções encontradas nas buscas. As contas ficam
// no código, em centavos: o LLM só copia os preços que o iFood devolveu e recebe o ranking pronto.
export const COMPARE_PRICES = 'compare_prices';
const MAX_OPTIONS = 15;

export const PRICE_TOOLS: Tool[] = [
  {
    name: COMPARE_PRICES,
    description:
      'Compara opções de pratos/lojas pelo custo real (itens + taxa de entrega − desconto) e devolve o ranking do mais barato ao mais caro, com a economia em relação à opção mais cara o valor por pessoa e alertas de pedido mínimo/orçamento. Use os valores exatamente como o iFood informou: unit_price = promotionalUnitPrice (se houver) senão unitPrice; delivery_fee = promotionalFee (se houver) senão fee; minimum_order = minimumOrderAmount de getMerchant. Nunca estime. Chame antes de recomendar quando houver 2 ou mais opções.',
    input_schema: {
      type: 'object',
      properties: {
        options: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_OPTIONS,
          items: {
            type: 'object',
            properties: {
              label: {
                type: 'string',
                description: 'Nome do prato/combo como o iFood mostra.',
              },
              restaurant: { type: 'string' },
              unit_price: {
                type: 'number',
                description: 'Preço unitário final em reais (com promoção).',
              },
              quantity: { type: 'integer', minimum: 1, default: 1 },
              delivery_fee: {
                type: 'number',
                description: 'Taxa de entrega da loja em reais (0 se grátis).',
              },
              discount: {
                type: 'number',
                description:
                  'Desconto/cupom em reais já confirmado pelo iFood.',
              },
              minimum_order: {
                type: 'number',
                description:
                  'Pedido mínimo da loja em reais (minimumOrderAmount).',
              },
            },
            required: ['label', 'restaurant', 'unit_price'],
          },
        },
        people: {
          type: 'integer',
          minimum: 1,
          description: 'Quantas pessoas dividem cada opção (padrão 1).',
        },
        budget_per_person: {
          type: 'number',
          description: 'Orçamento por pessoa em reais, se o usuário informou.',
        },
      },
      required: ['options'],
    },
  },
];

export function isPriceTool(name: string): boolean {
  return name === COMPARE_PRICES;
}

interface RankedOption {
  label: string;
  restaurant: string;
  totalCents: number;
  perPersonCents: number;
  feeCents: number;
  // Quanto falta em itens para atingir o pedido mínimo da loja (0 = atingido ou sem mínimo).
  missingForMinimumCents: number;
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > 120) {
    throw new GroupOrderError(`${field} inválido.`);
  }
  return v.replace(/\s+/g, ' ').trim();
};

export function comparePrices(rawInput: unknown): string {
  const input = (rawInput ?? {}) as Record<string, unknown>;
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
    const o = (raw ?? {}) as Record<string, unknown>;
    const quantity = o.quantity ?? 1;
    if (!Number.isInteger(quantity) || (quantity as number) < 1) {
      throw new GroupOrderError(`quantity inválida na opção ${i + 1}.`);
    }
    const unit = toCents(o.unit_price as number, `unit_price (opção ${i + 1})`);
    const fee =
      o.delivery_fee == null
        ? 0
        : toCents(o.delivery_fee as number, `delivery_fee (opção ${i + 1})`);
    const discount =
      o.discount == null
        ? 0
        : toCents(o.discount as number, `discount (opção ${i + 1})`);
    if (unit < 0 || fee < 0 || discount < 0) {
      throw new GroupOrderError(`Valores negativos na opção ${i + 1}.`);
    }
    const minimum =
      o.minimum_order == null
        ? 0
        : toCents(o.minimum_order as number, `minimum_order (opção ${i + 1})`);
    const itemsCents = unit * (quantity as number);
    const total = Math.max(0, itemsCents + fee - discount);
    return {
      label: str(o.label, `label (opção ${i + 1})`),
      restaurant: str(o.restaurant, `restaurant (opção ${i + 1})`),
      totalCents: total,
      perPersonCents: Math.ceil(total / (people as number)),
      feeCents: fee,
      missingForMinimumCents: Math.max(0, minimum - itemsCents),
    };
  });

  ranked.sort((a, b) => a.totalCents - b.totalCents);
  const priciest = ranked[ranked.length - 1].totalCents;

  const lines = ranked.map((o, i) => {
    const parts = [
      `${i + 1}. ${o.label} — ${o.restaurant}: total ${formatBRL(o.totalCents)}`,
    ];
    if (people !== 1) parts.push(`${formatBRL(o.perPersonCents)}/pessoa`);
    parts.push(
      o.feeCents === 0
        ? 'entrega grátis'
        : `inclui entrega ${formatBRL(o.feeCents)}`,
    );
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
