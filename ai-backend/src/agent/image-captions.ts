import { isObj, text as clean, type Obj } from '../common/json.js';
import { formatBRL } from '../group-order/index.js';

// Legendas das fotos a partir dos campos do Offer Discovery MCP (nome, preço, nota, entrega), sem
// depender do que o LLM escreveu.

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const text = (v: unknown, max = 60): string => clean(v, max);

// Valores do MCP vêm em reais (number).
const brl = (reais: number) => formatBRL(Math.round(reais * 100));

// Preço final do item: promotionalUnitPrice quando existe (e é menor), senão unitPrice.
function priceLabel(o: Obj): string {
  const unit = num(o.unitPrice);
  const promo = num(o.promotionalUnitPrice);
  if (promo !== null && unit !== null && promo < unit) {
    return `${brl(promo)} (de ${brl(unit)})`;
  }
  const price = promo ?? unit;
  return price === null ? '' : brl(price);
}

// Taxa de entrega: promotionalFee quando existe, senão fee. Em getMerchant (deliveryMethods[]),
// vale o método mais barato.
function deliveryLabel(o: Obj): string {
  const methods = Array.isArray(o.deliveryMethods)
    ? o.deliveryMethods.filter(isObj)
    : isObj(o.deliveryMethod)
      ? [o.deliveryMethod]
      : [];
  const fees = methods
    .map((m) => num(m.promotionalFee) ?? num(m.fee))
    .filter((f): f is number => f !== null);
  if (fees.length === 0) return '';
  const fee = Math.min(...fees);
  return fee === 0 ? 'entrega grátis' : `entrega ${brl(fee)}`;
}

export function merchantCaption(o: Obj): string {
  const rating = num(o.reviewRating);
  return [
    text(o.merchantName),
    rating === null ? '' : `⭐ ${rating.toFixed(1).replace('.', ',')}`,
    deliveryLabel(o),
  ]
    .filter(Boolean)
    .join(' · ');
}

// featuredItems de getMerchant não repetem o nome da loja: vem do objeto pai (inheritedMerchant).
export function itemCaption(o: Obj, inheritedMerchant: string): string {
  const merchant =
    text(o.merchantName) ||
    (isObj(o.merchant) ? text(o.merchant.merchantName) : '') ||
    inheritedMerchant;
  const name = text(o.itemName, 80);
  const price = priceLabel(o);
  return [name && price ? `${name} — ${price}` : name || price, merchant]
    .filter(Boolean)
    .join(' · ');
}
