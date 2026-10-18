// Tipos pensados para serem espelhados nos DTOs do NestJS.

export type PaymentMethod = "google_pay" | "pix"; // só pagamento pelo app

export interface CartItem {
  id: string;
  name: string;
  description: string;
  emoji: string;
  price: number;
  originalPrice?: number;
  qty: number;
  promo?: boolean;
  options?: { qty: number; name: string }[];
}

export interface RestaurantInfo {
  id: string;
  name: string;
  emoji: string;
  accent: string; // classes tailwind do gradiente do avatar/foto (placeholder)
}

// open: pode ser selecionado | awaiting_payment: Pix gerado | paid: já pago (por qualquer pessoa)
export type SubOrderStatus = "open" | "awaiting_payment" | "paid";

// Um pedido (link compartilhado) é composto por subpedidos. Dois subpedidos podem ser
// do mesmo restaurante (com itens diferentes) ou de restaurantes diferentes.
export interface SubOrder {
  id: string;
  label: string;
  restaurant: RestaurantInfo;
  items: CartItem[];
  fee: number; // taxa de entrega deste subpedido
  eta: string;
  status: SubOrderStatus;
  paidBy?: string;
}

export interface Address {
  id: string;
  street: string;
  district: string;
  complement: string;
}

export interface CreatePaymentPayload {
  orderId: string;
  subOrderId: string;
  addressId: string;
  payment: PaymentMethod;
  cpf?: string;
}

// Cobrança gerada para UM subpedido.
export interface Charge {
  id: string;
  subOrderId: string;
  total: number;
  payment: PaymentMethod;
  pixCode?: string;
  expiresAt?: number; // epoch ms
}
