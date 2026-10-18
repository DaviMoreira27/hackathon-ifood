import type { SyncCartInput } from '../group-order/index.js';
import { isObj, parseJsonSafe, pick, text, type Obj } from '../common/json.js';
import { unwrapToolText } from './tool-envelope.js';

// Leitura tolerante do resultado do getCart. O formato do MCP real não é documentado aqui: o
// parser procura os campos pelos nomes mais prováveis e confere que soma(preço × quantidade) =
// subtotal. Se algo não fecha, devolve o motivo e o hook manda o LLM usar group_sync_cart.

// JSON do resultado de uma ferramenta (sem o envelope de dados não confiáveis).
export const parseJson = (output: string): unknown =>
  parseJsonSafe(unwrapToolText(output));

// Valor em reais: número, string numérica ou { value | amount }.
function money(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) {
    return Number(v);
  }
  if (isObj(v)) return money(v.value ?? v.amount);
  return null;
}

const ITEM_LIST_KEYS = ['items', 'cartItems', 'lines', 'products'];
const SUBTOTAL_KEYS = [
  'subtotal',
  'subTotal',
  'itemsTotal',
  'itemsSubtotal',
  'itemsAmount',
];
const TOTAL_KEYS = ['total', 'totalAmount', 'totalPrice', 'orderTotal'];

// O objeto do carrinho: o primeiro (em largura) que tem lista de itens e total.
function findCart(root: unknown): Obj | null {
  const queue: Array<{ v: unknown; d: number }> = [{ v: root, d: 0 }];
  while (queue.length) {
    const { v, d } = queue.shift()!;
    if (d > 5) continue;
    if (Array.isArray(v)) {
      v.forEach((x) => queue.push({ v: x, d: d + 1 }));
      continue;
    }
    if (!isObj(v)) continue;
    const list = pick(v, ITEM_LIST_KEYS);
    if (Array.isArray(list) && pick(v, TOTAL_KEYS) !== undefined) return v;
    Object.values(v).forEach((x) => queue.push({ v: x, d: d + 1 }));
  }
  return null;
}

const cents = (reais: number) => Math.round(reais * 100);

export type ParsedCart =
  { ok: true; input: SyncCartInput } | { ok: false; reason: string };

export function parseCart(output: string, cartId: string): ParsedCart {
  const root = parseJson(output);
  if (root === undefined)
    return { ok: false, reason: 'getCart não devolveu JSON' };
  const cart = findCart(root);
  if (!cart) {
    return { ok: false, reason: 'não encontrei itens e total no getCart' };
  }

  const rawItems = pick(cart, ITEM_LIST_KEYS) as unknown[];
  const items: SyncCartInput['items'] = [];
  for (const [i, raw] of rawItems.entries()) {
    if (!isObj(raw)) return { ok: false, reason: `item ${i} inválido` };
    const id = pick(raw, ['cartItemId', 'cart_item_id', 'lineId', 'id']);
    const quantity = raw.quantity;
    const name =
      text(pick(raw, ['itemName', 'name', 'productName', 'description'])) ||
      (isObj(raw.item) ? text(raw.item.itemName ?? raw.item.name) : '');
    if ((typeof id !== 'string' && typeof id !== 'number') || !name) {
      return { ok: false, reason: `item ${i} sem cartItemId ou nome` };
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity)) {
      return { ok: false, reason: `item ${i} sem quantidade` };
    }
    // Preço unitário final (com opcionais): direto, ou o total da linha dividido pela quantidade.
    const unit = money(
      pick(raw, ['totalUnitPrice', 'finalUnitPrice', 'unitPriceWithOptions']),
    );
    const line = money(
      pick(raw, ['totalPrice', 'lineTotal', 'total', 'subtotal']),
    );
    const base = money(
      pick(raw, ['promotionalUnitPrice', 'unitPrice', 'price']),
    );
    const unitPrice =
      unit ??
      (line !== null && quantity > 0 && cents(line) % quantity === 0
        ? cents(line) / quantity / 100
        : base);
    if (unitPrice === null) {
      return { ok: false, reason: `item ${i} sem preço` };
    }
    items.push({ itemId: String(id), name, unitPrice, quantity });
  }

  const total = money(pick(cart, TOTAL_KEYS));
  const itemsCents = items.reduce(
    (sum, it) => sum + cents(it.unitPrice) * it.quantity,
    0,
  );
  const subtotal = money(pick(cart, SUBTOTAL_KEYS)) ?? itemsCents / 100;
  if (total === null) return { ok: false, reason: 'getCart sem total' };
  if (cents(subtotal) !== itemsCents) {
    return {
      ok: false,
      reason: `a soma dos itens (${itemsCents / 100}) não bate com o subtotal (${subtotal})`,
    };
  }

  const merchant = isObj(cart.merchant) ? cart.merchant : {};
  const restaurantName =
    text(pick(cart, ['merchantName', 'restaurantName', 'storeName']), 120) ||
    text(merchant.merchantName ?? merchant.name, 120);
  if (!restaurantName) return { ok: false, reason: 'getCart sem nome da loja' };

  return {
    ok: true,
    input: { ifoodCartId: cartId, restaurantName, subtotal, total, items },
  };
}
