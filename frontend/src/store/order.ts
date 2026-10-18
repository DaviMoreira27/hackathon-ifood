"use client";
import { create } from "zustand";
import { ADDRESS, ORDER_ID, SUB_ORDERS } from "@/lib/mock";
import type { Address, Charge, PaymentMethod, SubOrder, SubOrderStatus } from "@/lib/types";

// Os subpedidos vêm prontos do backend: o front só exibe e deixa escolher UM para pagar.
interface OrderState {
  orderId: string;
  subOrders: SubOrder[];
  selectedId: string | null;
  address: Address;
  payment: PaymentMethod;
  cpf: string;
  charge: Charge | null;

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
  subOrders: SUB_ORDERS.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i })) })),
  selectedId: null as string | null,
  address: ADDRESS,
  payment: "google_pay" as PaymentMethod,
  cpf: "",
  charge: null as Charge | null,
});

export const useOrder = create<OrderState>((set) => ({
  ...initial(),
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
