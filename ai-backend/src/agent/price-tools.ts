import type {
  MessageParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages.js';
import { GroupOrderError } from '../group-order/group-order.errors.js';
import { formatBRL, toCents } from '../group-order/money.js';
import { isObj, text as clean, type Obj } from '../common/json.js';
import { unwrapToolText } from './tool-envelope.js';

// Ferramenta local (não vai ao iFood) para comparar opções encontradas nas buscas. O LLM só
// escolhe as opções (item_id); preço, taxa de entrega e pedido mínimo são lidos pelo código nos
// resultados das ferramentas da conversa, e as contas são feitas em centavos. O LLM nunca
// transcreve número: uma taxa copiada errado mudava a recomendação.
export const COMPARE_PRICES = 'compare_prices';
const MAX_OPTIONS = 15;

export const PRICE_TOOLS: Tool[] = [
  {
    name: COMPARE_PRICES,
    description:
      'Compara opções de pratos/lojas pelo custo real (item + taxa de entrega) e devolve o ranking do mais barato ao mais caro, com o preço do item, a taxa, o total, a economia em relação à opção mais cara, o valor por pessoa e alertas de pedido mínimo/orçamento. Informe só o item_id de cada opção: o sistema lê preço (promocional, se houver), taxa de entrega e pedido mínimo nos resultados de searchOffers, getItem e getMerchant desta conversa. Se faltar algum dado, a ferramenta diz qual consulta fazer. Chame antes de recomendar quando houver 2 ou mais opções e use os valores que ela devolve.',
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
              item_id: {
                type: 'string',
                description: 'itemId do cardápio, como veio do iFood.',
              },
              quantity: { type: 'integer', minimum: 1, default: 1 },
              delivery_type: {
                type: 'string',
                enum: ['ECONOMIC', 'EXPRESS'],
                description:
                  'Método de entrega a considerar. Sem isso, vale o mais barato da loja.',
              },
            },
            required: ['item_id'],
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

// ─── fatos de preço lidos dos resultados das ferramentas ─────────────────────

interface ItemFact {
  label: string;
  priceCents: number;
  merchantId?: string;
  merchantName?: string;
}

interface MerchantFact {
  name?: string;
  fees: Array<{ type?: string; cents: number }>;
  // A taxa veio de um objeto de loja (getMerchant), não da cópia resumida num item de busca.
  fromMerchant: boolean;
  minimumCents?: number;
}

export interface PriceFacts {
  items: Map<string, ItemFact>;
  merchants: Map<string, MerchantFact>;
}

const reais = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const cents = (v: number) => Math.round(v * 100);
const text = (v: unknown) => clean(v, 120);

function feesOf(o: Obj): MerchantFact['fees'] {
  const methods = Array.isArray(o.deliveryMethods)
    ? o.deliveryMethods.filter(isObj)
    : isObj(o.deliveryMethod)
      ? [o.deliveryMethod]
      : [];
  return methods.flatMap((m) => {
    const fee = reais(m.promotionalFee) ?? reais(m.fee);
    return fee === null
      ? []
      : [
          {
            type: typeof m.type === 'string' ? m.type : undefined,
            cents: cents(fee),
          },
        ];
  });
}

function walk(
  value: unknown,
  facts: PriceFacts,
  parent: { id?: string; name?: string },
  depth = 0,
): void {
  if (depth > 12) return;
  if (Array.isArray(value)) {
    for (const v of value) walk(v, facts, parent, depth + 1);
    return;
  }
  if (!isObj(value)) return;

  const nested = isObj(value.merchant) ? value.merchant : {};
  const merchantId =
    text(value.merchantId) || text(nested.merchantId) || parent.id;
  const merchantName =
    text(value.merchantName) || text(nested.merchantName) || parent.name;
  const itemId = text(value.itemId);
  const fees = feesOf(value);

  if (itemId) {
    const unit = reais(value.unitPrice);
    const promo = reais(value.promotionalUnitPrice);
    const price =
      promo !== null && (unit === null || promo < unit) ? promo : unit;
    const label = text(value.itemName);
    if (price !== null && label && !facts.items.has(itemId)) {
      facts.items.set(itemId, {
        label,
        priceCents: cents(price),
        merchantId,
        merchantName,
      });
    }
  }

  if (merchantId) {
    const current = facts.merchants.get(merchantId) ?? {
      fees: [],
      fromMerchant: false,
    };
    current.name ??= merchantName;
    const isMerchantObject = !itemId && !!text(value.merchantId);
    if (
      fees.length &&
      (isMerchantObject || !current.fees.length) &&
      !current.fromMerchant
    ) {
      current.fees = fees;
      current.fromMerchant = isMerchantObject;
    }
    const minimum = reais(value.minimumOrderAmount);
    if (minimum !== null && isMerchantObject)
      current.minimumCents = cents(minimum);
    facts.merchants.set(merchantId, current);
  }

  const next =
    !itemId && text(value.merchantId)
      ? { id: merchantId, name: merchantName }
      : parent;
  for (const v of Object.values(value)) walk(v, facts, next, depth + 1);
}

export function priceFacts(messages: MessageParam[]): PriceFacts {
  const facts: PriceFacts = { items: new Map(), merchants: new Map() };
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string')
      continue;
    for (const block of message.content) {
      if (block.type !== 'tool_result' || typeof block.content !== 'string')
        continue;
      try {
        walk(JSON.parse(unwrapToolText(block.content)), facts, {});
      } catch {
        // Resultado que não é JSON não tem preço estruturado.
      }
    }
  }
  return facts;
}

// ─── ranking ─────────────────────────────────────────────────────────────────

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
