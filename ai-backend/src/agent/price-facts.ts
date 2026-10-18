import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import { isObj, text as clean, type Obj } from '../common/json.js';
import { unwrapToolText } from './tool-envelope.js';

// Fatos de preço (item, loja, taxas de entrega, pedido mínimo) lidos dos resultados das
// ferramentas da conversa. É daqui que o compare_prices tira os números: o LLM nunca os transcreve.

export interface ItemFact {
  label: string;
  priceCents: number;
  merchantId?: string;
  merchantName?: string;
}

export interface MerchantFact {
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
