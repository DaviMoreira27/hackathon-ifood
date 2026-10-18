"use client";
import { create } from "zustand";
import { ADDRESS, ORDER_ID, SUB_ORDERS } from "@/lib/mock";
import { toSubOrders } from "@/lib/order-view";
import type { Address, Charge, PayerOrderView, PaymentMethod, SubOrder, SubOrderStatus } from "@/lib/types";

// Os subpedidos vêm prontos do backend: o front só exibe e deixa escolher UM para pagar.
interface OrderState {
  orderId: string;
  // token do link de pagamento (null = simulação com dados mockados)
  token: string | null;
  subOrders: SubOrder[];
  selectedId: string | null;
  address: Address;
  payment: PaymentMethod;
  cpf: string;
  charge: Charge | null;

  load: (token: string, view: PayerOrderView) => void;
  select: (id: string) => void;
  clearSelection: () => void;
  setSubOrderStatus: (id: string, status: SubOrderStatus, paidBy?: string) => void;
  setPayment: (p: PaymentMethod) => void;
  setCpf: (cpf: string) => void;
  setCharge: (c: Charge | null) => void;
  reset: () => void;
}

const initial = () => ({
  orderId: ORDER_ID,
  token: null as string | null,
  subOrders: SUB_ORDERS.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i })) })),
  selectedId: null as string | null,
  address: ADDRESS,
  payment: "google_pay" as PaymentMethod,
  cpf: "",
  charge: null as Charge | null,
});

export const useOrder = create<OrderState>((set) => ({
  ...initial(),
  // Pedido real (link do Telegram). O status vem da cobrança no mock; só o "Pix gerado" é deste
  // aparelho, então é mantido ao recarregar.
  load: (token, view) =>
    set((s) => {
      const subOrders = toSubOrders(view).map((x) => {
        const local = s.token === token ? s.subOrders.find((o) => o.id === x.id) : undefined;
        return x.status === "open" && local?.status === "awaiting_payment" ? { ...x, status: local.status } : x;
      });
      const own = subOrders.find((x) => x.id === view.ownChargeReference);
      return {
        token,
        orderId: view.label,
        address: view.address ? { id: view.reference, ...view.address } : s.address,
        subOrders,
        selectedId: own?.status === "open" ? own.id : null,
      };
    }),
  // só subpedidos em aberto podem ser selecionados
  select: (id) =>
    set((s) => (s.subOrders.find((x) => x.id === id)?.status === "open" ? { selectedId: id } : s)),
  clearSelection: () => set({ selectedId: null }),
  setSubOrderStatus: (id, status, paidBy) =>
    set((s) => ({ subOrders: s.subOrders.map((x) => (x.id === id ? { ...x, status, paidBy } : x)) })),
  setPayment: (payment) => set({ payment }),
  setCpf: (cpf) => set({ cpf }),
  setCharge: (charge) => set({ charge }),
  reset: () => set(initial()),
}));

export const selectCurrent = (s: OrderState) => s.subOrders.find((x) => x.id === s.selectedId) ?? null;

export function getTotals(subOrders: SubOrder[]) {
  const all = subOrders.flatMap((r) => r.items);
  const subtotal = all.reduce((s, i) => s + i.price * i.qty, 0);
  const original = all.reduce((s, i) => s + (i.originalPrice ?? i.price) * i.qty, 0);
  const fee = subOrders.reduce((s, r) => s + r.fee, 0);
  return {
    subtotal,
    original,
    fee,
    total: subtotal + fee,
    savings: original - subtotal,
    count: all.reduce((s, i) => s + i.qty, 0),
    hasDiscount: original > subtotal,
  };
}
