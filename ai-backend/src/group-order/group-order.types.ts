import { carts, orders } from '../db/schema.js';
import { GroupOrderError } from './group-order.errors.js';

export type OrderRow = typeof orders.$inferSelect;
export type CartRow = typeof carts.$inferSelect;

export interface SyncCartInput {
  ifoodCartId: string;
  restaurantName: string;
  subtotal: number;
  total: number;
  items: Array<{
    itemId: string;
    name: string;
    unitPrice: number;
    quantity: number;
  }>;
}

export interface AssignPayerInput {
  ifoodCartId: string;
  itemId: string;
  participantName: string;
}

export interface CartSummary {
  ifood_cart_id: string;
  restaurant: string;
  subtotal: string;
  total: string;
  items: Array<{
    item_id: string;
    name: string;
    unit_price: string;
    quantity: number;
    payer: string | null;
  }>;
  warnings: string[];
}

export type SyncCartResult =
  CartSummary | { removed: boolean; ifood_cart_id: string };

export interface OrderView {
  order: { id: number; status: string } | null;
  hint?: string;
  participants?: string[];
  carts?: Array<
    Omit<CartSummary, 'warnings'> & { status: string; payers: string[] }
  >;
  amounts_preview?: Array<Record<string, string>>;
  payments?: Array<{
    participant: string;
    restaurant: string;
    amount: string;
    status: string;
  }>;
  problems?: string[];
  awaiting_finalization: Array<{
    order_id: number;
    carts: Array<{ ifood_cart_id: string; restaurant: string }>;
  }>;
}

export interface PaymentLink {
  participant: string;
  restaurant: string;
  amount: string;
  url: string;
}

export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanName(name: unknown): string {
  const cleaned =
    typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  if (!cleaned || cleaned.length > 60) {
    throw new GroupOrderError('Nome inválido: use de 1 a 60 caracteres.');
  }
  return cleaned;
}

export const cartLabel = (
  cart: Pick<CartRow, 'restaurantName' | 'ifoodCartId'>,
) => cart.restaurantName ?? cart.ifoodCartId;
