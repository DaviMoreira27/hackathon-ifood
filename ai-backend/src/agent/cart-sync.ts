import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import type { SyncCartInput } from '../group-order/group-order.service.js';
import { UNTRUSTED_TAG } from './tool-policy.js';

// Sync automático do carrinho: depois de cada alteração bem-sucedida num carrinho do iFood, o
// código lê o carrinho (getCart) e registra no pedido em grupo os itens, preços, subtotal e total
// exatamente como o iFood devolveu. O LLM nunca transcreve número que vira cobrança.
// O formato do getCart do MCP real não é documentado aqui: o parser procura os campos pelos nomes
// mais prováveis e confere que soma(preço × quantidade) = subtotal. Se algo não fecha, devolve o
// motivo e o agent avisa o LLM para usar group_sync_cart (caminho manual, de reserva).

export const GET_CART = 'getCart';
const DEFAULT_SYNC_TOOLS = [
  'addItemToCart',
  'updateCartItem',
  'removeItemFromCart',
  'setCartDelivery',
  'setVoucher',
  'removeVoucher',
];

// MCP_CART_SYNC_TOOLS (nomes separados por vírgula) substitui a lista padrão.
export function triggersCartSync(name: string): boolean {
  const configured = process.env.MCP_CART_SYNC_TOOLS;
  const list = configured
    ? configured.split(',').map((s) => s.trim())
    : DEFAULT_SYNC_TOOLS;
  return list.includes(name);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const CART_ID_KEYS = ['cartId', 'cart_id', 'ifoodCartId'];

function findCartId(value: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findCartId(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isObj(value)) return null;
  for (const key of CART_ID_KEYS) {
    const v = value[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  if (isObj(value.cart) && typeof value.cart.id === 'string') {
    return value.cart.id;
  }
  for (const v of Object.values(value)) {
    const found = findCartId(v, depth + 1);
    if (found) return found;
  }
  return null;
}

export const unwrapToolText = (content: string) =>
  content
    .replace(new RegExp(`^<${UNTRUSTED_TAG}[^>]*>\\n`), '')
    .replace(new RegExp(`\\n</${UNTRUSTED_TAG}>$`), '');

function parseJson(text: string): unknown {
  try {
    return JSON.parse(unwrapToolText(text));
  } catch {
    return undefined;
  }
}

// O carrinho alterado: primeiro o argumento da chamada, depois o resultado da ferramenta.
export function cartIdOf(input: unknown, output: string): string | null {
  return findCartId(input) ?? findCartId(parseJson(output));
}

// Argumentos do getCart a partir do schema anunciado pelo MCP. null = não dá para saber.
export function getCartArgs(
  tools: Tool[],
  cartId: string,
): Record<string, string> | null {
  const tool = tools.find((t) => t.name === GET_CART);
  if (!tool) return null;
  const schema = tool.input_schema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const props = Object.keys(schema.properties ?? {});
  const key =
    CART_ID_KEYS.find((k) => props.includes(k)) ??
    (schema.required?.length === 1 ? schema.required[0] : undefined) ??
    (props.length === 1 ? props[0] : undefined);
  return key ? { [key]: cartId } : null;
}

// ─── leitura tolerante do resultado do getCart ──────────────────────────────

// Valor em reais: número, string numérica ou { value | amount }.
function money(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) {
    return Number(v);
  }
  if (isObj(v)) return money(v.value ?? v.amount);
  return null;
}

function pick(o: Obj, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

function text(v: unknown, max = 200): string {
  return typeof v === 'string'
    ? v.replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
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
