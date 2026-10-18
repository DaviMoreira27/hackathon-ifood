import { GroupOrderError } from './group-order.errors.js';

// Leitura dos argumentos que o LLM manda às ferramentas group_*: campo inválido vira
// GroupOrderError, que volta ao modelo como erro da ferramenta.

export type Input = Record<string, unknown>;

export function str(input: Input, key: string, max = 300): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new GroupOrderError(`Campo "${key}" ausente ou inválido.`);
  }
  return value.trim();
}

export function num(input: Input, key: string): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GroupOrderError(
      `Campo "${key}" ausente ou inválido (precisa ser um número em reais).`,
    );
  }
  return value;
}

export function parseSyncCart(input: Input) {
  const rawItems = input.items;
  if (!Array.isArray(rawItems) || rawItems.length > 100) {
    throw new GroupOrderError(
      'Campo "items" precisa ser uma lista com até 100 itens.',
    );
  }
  return {
    ifoodCartId: str(input, 'ifood_cart_id', 200),
    restaurantName: str(input, 'restaurant_name', 120),
    subtotal: num(input, 'subtotal'),
    total: num(input, 'total'),
    items: rawItems.map((raw, index) => {
      const item = (raw && typeof raw === 'object' ? raw : {}) as Input;
      const quantity = item.quantity;
      if (
        typeof quantity !== 'number' ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 99
      ) {
        throw new GroupOrderError(
          `items[${index}].quantity deve ser um inteiro de 1 a 99.`,
        );
      }
      return {
        itemId: str(item, 'item_id', 200),
        name: str(item, 'name', 200),
        unitPrice: num(item, 'unit_price'),
        quantity,
      };
    }),
  };
}

export function optionalInt(input: Input, key: string): number | undefined {
  const raw = input[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new GroupOrderError(`Campo "${key}" deve ser um inteiro.`);
  }
  return raw;
}
