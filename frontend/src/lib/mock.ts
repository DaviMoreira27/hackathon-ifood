import type { Address, PaymentMethod, SubOrder } from "./types";

export const PIX_TTL_SECONDS = 8 * 60;
export const ORDER_ID = "#4821";

const SANDUWISH = { id: "sanduwish-smash-house", name: "Sanduwish- Smash House", emoji: "🍔", accent: "from-fuchsia-500 via-orange-400 to-amber-300" };
const DOCE = { id: "doce-vicio", name: "Doce Vício Confeitaria", emoji: "🍰", accent: "from-pink-400 via-rose-400 to-orange-300" };
const FORNO = { id: "forno-e-brasa", name: "Forno & Brasa Pizzaria", emoji: "🍕", accent: "from-red-500 via-orange-500 to-yellow-400" };

// Um pedido com 4 subpedidos: 2 do mesmo restaurante (itens diferentes), 1 de outro,
// e 1 que outra pessoa já pagou.
export const SUB_ORDERS: SubOrder[] = [
  {
    id: "s1",
    label: "Subpedido 1",
    restaurant: SANDUWISH,
    fee: 5.99,
    eta: "Hoje, 15 - 25min",
    status: "open",
    items: [
      {
        id: "combo-bravissimo",
        name: "Combo Bravíssimo Burger",
        description: "Bravíssimo + Batata Palito o...",
        emoji: "🍔",
        price: 44.93,
        originalPrice: 65.3,
        qty: 1,
        promo: true,
        options: [
          { qty: 1, name: "Alho" },
          { qty: 1, name: "Picles" },
          { qty: 1, name: "Chips artesanal" },
          { qty: 1, name: "Guaraná zero" },
        ],
      },
    ],
  },
  {
    id: "s2",
    label: "Subpedido 2",
    restaurant: SANDUWISH,
    fee: 5.99,
    eta: "Hoje, 15 - 25min",
    status: "open",
    items: [
      { id: "batata-rustica", name: "Batata rústica", description: "Porção individual", emoji: "🍟", price: 18.9, qty: 1 },
      { id: "refri-lata", name: "Refrigerante lata", description: "350ml", emoji: "🥤", price: 8.0, qty: 1 },
    ],
  },
  {
    id: "s3",
    label: "Subpedido 3",
    restaurant: DOCE,
    fee: 4.5,
    eta: "Hoje, 25 - 35min",
    status: "open",
    items: [
      {
        id: "cheesecake",
        name: "Cheesecake com calda",
        description: "Fatia individual",
        emoji: "🍰",
        price: 22.9,
        qty: 1,
        options: [
          { qty: 1, name: "Calda de caramelo" },
          { qty: 1, name: "Morango" },
          { qty: 1, name: "Sem granulado" },
        ],
      },
    ],
  },
  {
    id: "s4",
    label: "Subpedido 4",
    restaurant: FORNO,
    fee: 6.5,
    eta: "Hoje, 30 - 40min",
    status: "paid",
    paidBy: "Mariana",
    items: [{ id: "pizza-marg", name: "Pizza Margherita", description: "Grande, 8 fatias", emoji: "🍕", price: 49.9, qty: 1 }],
  },
];

export const ADDRESS: Address = {
  id: "a1",
  street: "Rua Doutor Carlos De Camargo Salles, 418",
  district: "Cidade Universitária",
  complement: "apartamento 07",
};

export const PAYMENT_META: Record<PaymentMethod, { label: string }> = {
  google_pay: { label: "Google Pay" },
  pix: { label: "Pix" },
};
