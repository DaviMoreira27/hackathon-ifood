"use client";
import type { KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Check } from "@/components/icons";
import { BottomTotal, Radio, SacolaHeader, Screen } from "@/components/ui";
import { brl } from "@/lib/format";
import { getTotals, selectCurrent, useOrder } from "@/store/order";
import type { SubOrder } from "@/lib/types";

function Marker({ sub, selected }: { sub: SubOrder; selected: boolean }) {
  if (sub.status === "paid")
    return <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-saving text-white"><Check className="h-4 w-4" strokeWidth={3} /></span>;
  if (sub.status === "awaiting_payment")
    return <span className="block h-7 w-7 shrink-0 rounded-full border-2 border-dashed border-muted" />;
  return <Radio selected={selected} tone="brand" />;
}

function StatusBadge({ sub }: { sub: SubOrder }) {
  if (sub.status === "paid")
    return <span className="rounded-full bg-[#E3F6EA] px-3 py-1 text-[14px] text-saving">Pago{sub.paidBy ? ` por ${sub.paidBy}` : ""}</span>;
  if (sub.status === "awaiting_payment")
    return <span className="rounded-full bg-[#FFF3D6] px-3 py-1 text-[14px] text-[#8A5A00]">Aguardando pagamento</span>;
  return null;
}

export default function SacolaPage() {
  const router = useRouter();
  const subOrders = useOrder((s) => s.subOrders);
  const orderId = useOrder((s) => s.orderId);
  const select = useOrder((s) => s.select);
  const current = useOrder(selectCurrent);

  const picked = current?.status === "open" ? current : null;
  const t = picked ? getTotals([picked]) : null;
  const paid = subOrders.filter((s) => s.status === "paid").length;
  const openCount = subOrders.filter((s) => s.status === "open").length;

  const onKey = (e: KeyboardEvent, sub: SubOrder) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(sub.id); }
  };

  return (
    <Screen
      header={<SacolaHeader title={`PEDIDO ${orderId}`} />}
      footer={
        <BottomTotal
          total={t ? brl(t.total) : null}
          count={t?.count ?? 0}
          emptyText={openCount === 0 ? "Nada a pagar por aqui" : "Selecione um subpedido"}
          onContinue={() => router.push("/checkout")}
        />
      }
    >
      <p className="text-[17px] text-ink">
        {subOrders.length} subpedidos • {paid} {paid === 1 ? "pago" : "pagos"}
      </p>
      <p className="mt-1 text-[15px] leading-snug text-muted">
        {openCount === 0
          ? "Todos os subpedidos já foram pagos ou estão aguardando pagamento."
          : "Escolha o subpedido que você vai pagar. Cada um só pode ser pago uma vez; para pagar outro, volte a este link."}
      </p>

      <ul className="mt-4 space-y-4" role="radiogroup" aria-label="Subpedidos">
        {subOrders.map((sub) => {
          const open = sub.status === "open";
          const selected = open && sub.id === picked?.id;
          return (
            <li key={sub.id}>
              <div
                role="radio"
                aria-checked={selected}
                aria-disabled={!open}
                tabIndex={open ? 0 : -1}
                onClick={() => open && select(sub.id)}
                onKeyDown={(e) => open && onKey(e, sub)}
                className={`rounded-3xl p-5 outline-offset-2 transition ${
                  selected ? "border-2 border-brand bg-[#FFF8F8]" : "border border-line"
                } ${open ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}
              >
                <div className="flex items-center gap-3">
                  <Marker sub={sub} selected={selected} />
                  <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${sub.restaurant.accent} text-xl`}>
                    {sub.restaurant.emoji}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[19px] leading-tight text-ink">{sub.restaurant.name}</p>
                    <p className="text-[14px] text-muted">{sub.label}</p>
                  </div>
                </div>
                {!open && <div className="mt-3"><StatusBadge sub={sub} /></div>}

                <ul className="mt-5 space-y-5">
                  {sub.items.map((item) => (
                    <li key={item.id}>
                      {item.promo && <p className="mb-2 text-[14px] text-saving">🏷️ Item promocional</p>}
                      <div className="flex items-start gap-4">
                        <div className={`flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${sub.restaurant.accent} text-3xl`}>
                          {item.emoji}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-[18px] leading-tight text-ink">{item.name}</p>
                          {item.description && <p className="mt-0.5 truncate text-[15px] text-muted">{item.description}</p>}
                          <p className="mt-1 text-[18px] font-medium text-ink">
                            {brl(item.price)}{" "}
                            {item.originalPrice && (
                              <span className="text-[14px] font-normal text-muted line-through">{brl(item.originalPrice)}</span>
                            )}
                          </p>
                        </div>
                        <span
                          aria-label={`Quantidade: ${item.qty}`}
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line text-[15px] text-ink"
                        >
                          {item.qty}x
                        </span>
                      </div>
                      {item.options && (
                        <ul className="mt-2.5 space-y-1.5 text-[16px] text-ink">
                          {item.options.map((o) => (
                            <li key={o.name} className="flex items-center gap-3">
                              <span className="flex h-6 min-w-7 items-center justify-center rounded-full bg-soft text-[13px] text-muted">{o.qty}</span>
                              {o.name}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>

                <p className="mt-5 flex justify-between border-t border-line pt-4 text-[15px] text-muted">
                  <span>Entrega • {sub.eta}</span>
                  <span className="text-ink">{brl(sub.fee)}</span>
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </Screen>
  );
}
