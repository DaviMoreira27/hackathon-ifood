"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Check } from "@/components/icons";
import { PrimaryButton, Screen } from "@/components/ui";
import { brl } from "@/lib/format";
import { PAYMENT_META } from "@/lib/mock";
import { useOrder } from "@/store/order";

export default function PedidoConfirmadoPage() {
  const router = useRouter();
  const charge = useOrder((s) => s.charge);
  const payment = useOrder((s) => s.payment);
  const orderId = useOrder((s) => s.orderId);
  const subOrders = useOrder((s) => s.subOrders);
  const clearSelection = useOrder((s) => s.clearSelection);
  const setCharge = useOrder((s) => s.setCharge);

  const sub = subOrders.find((x) => x.id === charge?.subOrderId) ?? null;
  const remaining = subOrders.filter((x) => x.status === "open").length;

  useEffect(() => {
    if (!charge) router.replace("/sacola");
  }, [charge, router]);
  if (!charge || !sub) return null;

  // "entrar de novo no link": volta à lista, que agora mostra este subpedido como pago
  const backToOrder = () => {
    clearSelection();
    setCharge(null);
    router.push("/sacola");
  };

  return (
    <Screen
      header={<div className="h-6" />}
      footer={
        <PrimaryButton onClick={backToOrder}>
          {remaining > 0 ? "Pagar outro subpedido" : "Voltar ao pedido"}
        </PrimaryButton>
      }
    >
      <div className="mt-16 flex flex-col items-center text-center">
        <span className="flex h-24 w-24 items-center justify-center rounded-full bg-saving text-white">
          <Check className="h-12 w-12" strokeWidth={3} />
        </span>
        <h1 className="mt-8 text-[26px] font-medium text-ink">Pagamento confirmado!</h1>
        <p className="mt-3 max-w-[320px] text-[18px] text-muted">
          {sub.restaurant.name} recebeu o {sub.label.toLowerCase()} do pedido {orderId}. Previsão de chegada: {sub.eta.replace("Hoje, ", "")}.
        </p>
        <p className="mt-6 text-[18px] text-ink">{PAYMENT_META[payment].label} • {brl(charge.total)}</p>
        <p className="mt-3 text-[15px] text-muted">
          {remaining > 0
            ? `Ainda ${remaining === 1 ? "falta 1 subpedido" : `faltam ${remaining} subpedidos`} para pagar neste pedido.`
            : "Todos os subpedidos deste pedido já foram pagos."}
        </p>
      </div>
    </Screen>
  );
}
