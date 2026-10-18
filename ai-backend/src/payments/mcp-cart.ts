// Lê a saída do getCart (CartDetailsResponse do MCP do iFood) só para enriquecer o que o pagador
// vê: nome da loja, observação e complementos de cada item, prazo e endereço de entrega.
// Valores (preço, total) NUNCA saem daqui: vêm do banco (o que o sistema cobrou).

export interface McpCartItem {
  cartItemId: string;
  itemId: string;
  name: string;
  customerNote: string | null;
  options: { name: string; quantity: number }[];
}

export interface McpCartInfo {
  merchantName: string | null;
  eta: string | null;
  address: { street: string; district: string; complement: string } | null;
  items: McpCartItem[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 200): string =>
  typeof v === 'string' || typeof v === 'number'
    ? String(v).replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
const qty = (v: unknown): number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 1;
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

// O formato de `options` não é documentado: aceita {name|optionName, quantity} e grupos com
// lista aninhada (options/items).
function options(value: unknown, depth = 0): McpCartItem['options'] {
  if (depth > 3) return [];
  return list(value).flatMap((o) => {
    const nested = [...list(o.options), ...list(o.items)];
    if (nested.length) return options(nested, depth + 1);
    const name = text(o.name ?? o.optionName ?? o.itemName, 120);
    return name ? [{ name, quantity: qty(o.quantity) }] : [];
  });
}

function eta(deliveryMethod: unknown): string | null {
  if (!isObj(deliveryMethod)) return null;
  const minutes = deliveryMethod.estimatedMinutes;
  if (!isObj(minutes)) return null;
  const min = Number(minutes.min);
  const max = Number(minutes.max);
  if (!(min > 0) || !(max >= min)) return null;
  return `Hoje, ${min} - ${max}min`;
}

function address(value: unknown): McpCartInfo['address'] {
  if (!isObj(value)) return null;
  const street = text(value.streetName);
  if (!street) return null;
  const number = text(value.streetNumber);
  return {
    street: number ? `${street}, ${number}` : street,
    district: text(value.neighborhood),
    complement: text(value.complement),
  };
}

export function parseMcpCart(raw: string): McpCartInfo | null {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(root)) return null;
  const merchant = isObj(root.merchant) ? root.merchant : {};
  return {
    merchantName: text(merchant.merchantName) || null,
    eta: eta(root.deliveryMethod),
    address: address(root.deliveryAddress),
    items: list(root.items).map((i) => ({
      cartItemId: text(i.cartItemId, 100),
      itemId: text(i.itemId, 100),
      name: text(i.name),
      customerNote: text(i.customerNote, 300) || null,
      options: options(i.options),
    })),
  };
}

// Item do banco ↔ item do getCart. O banco guarda o cartItemId (ver system-prompt), mas aceita
// também o itemId do cardápio.
export function matchItem(
  info: McpCartInfo,
  ifoodItemId: string,
): McpCartItem | null {
  return (
    info.items.find(
      (i) => i.cartItemId === ifoodItemId || i.itemId === ifoodItemId,
    ) ?? null
  );
}
