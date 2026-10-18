"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bike, ChevronDown, ChevronRight, GPayLogo, IfoodPago, Lock, Pin, PixLogo, Receipt } from "@/components/icons";
import { PrimaryButton, SacolaHeader, Screen, Sheet } from "@/components/ui";
import { brl, maskCpf } from "@/lib/format";
import { PAYMENT_META } from "@/lib/mock";
import { createPayment } from "@/services/api";
import { getTotals, selectCurrent, useOrder } from "@/store/order";
import type { PaymentMethod } from "@/lib/types";

function MethodIcon({ method }: { method: PaymentMethod }) {
  return method === "pix" ? <PixLogo size={30} /> : <GPayLogo />;
}

export default function CheckoutPage() {
  const router = useRouter();
  const { orderId, address, payment, cpf, setCpf, setCharge, setSubOrderStatus } = useOrder();
  const current = useOrder(selectCurrent);
  const meta = PAYMENT_META[payment];

  const [reviewOpen, setReviewOpen] = useState(false);
  const [savingsOpen, setSavingsOpen] = useState(false);
  const [couponInfo, setCouponInfo] = useState(false);
  const [teletonInfo, setTeletonInfo] = useState(false);
  const [editCpf, setEditCpf] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const cpfValid = cpf.replace(/\D/g, "").length === 11;

  // sem subpedido selecionado (acesso direto à URL) volta para a lista
  useEffect(() => {
    if (!current) router.replace("/sacola");
  }, [current, router]);
  if (!current) return null;
  const t = getTotals([current]);
  const subId = current.id; // função declarada abaixo não herda o narrowing de `current`

  async function placeOrder() {
    setSubmitting(true);
    setError("");
    try {
      const charge = await createPayment(
        {
          orderId,
          subOrderId: subId,
          addressId: address.id,
          payment,
          cpf: cpfValid ? cpf.replace(/\D/g, "") : undefined,
        },
        t.total
      );
      setCharge(charge);
      // Pix fica aguardando; Google Pay é aprovado na hora (simulação)
      if (payment === "pix") setSubOrderStatus(subId, "awaiting_payment");
      else setSubOrderStatus(subId, "paid", "Você");
      router.push(payment === "pix" ? "/pix" : "/pedido-confirmado");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao fazer o pedido");
      setSubmitting(false);
    }
  }

  return (
    <>
      <Screen
        header={<SacolaHeader onBack={() => router.back()} />}
        footer={
          <PrimaryButton onClick={() => setReviewOpen(true)}>
            Finalizar <span className="mx-2">•</span> {brl(t.total)}
          </PrimaryButton>
        }
      >
        <h2 className="mt-2 text-[22px] font-medium text-ink">Você vai pagar</h2>
        <section className="mt-3 rounded-3xl border border-line p-5">
          <div className="flex items-center gap-4">
            <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${current.restaurant.accent} text-xl`}>
              {current.restaurant.emoji}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[19px] text-ink">{current.restaurant.name}</p>
              <p className="text-[14px] text-muted">{current.label} • pedido {orderId}</p>
            </div>
          </div>
          <ul className="mt-4 space-y-1.5 text-[16px] text-ink">
            {current.items.map((i) => (
              <li key={i.id} className="flex justify-between gap-3">
                <span className="truncate">{i.qty}x {i.name}</span>
                <span className="shrink-0 text-muted">{brl(i.price * i.qty)}</span>
              </li>
            ))}
          </ul>
        </section>

        <h2 className="mt-9 text-[22px] font-medium text-ink">Pagamento pelo app</h2>

        {/* Clicar aqui leva para a tela de pagamento (iFood Pago) */}
        <section className="mt-4 rounded-3xl bg-soft p-2">
          <div className="px-4 pb-3 pt-4 text-[22px]"><IfoodPago /></div>
          <div className="overflow-hidden rounded-3xl bg-white">
            <button
              onClick={() => router.push("/pagamento")}
              className="flex w-full items-center justify-between px-5 py-6 text-left"
            >
              <span className="flex items-center gap-4 text-[21px] text-ink">
                <MethodIcon method={payment} /> {meta.label}
              </span>
              <ChevronRight className="h-5 w-5 text-ink" />
            </button>
            {payment === "google_pay" ? (
              <button
                onClick={() => router.push("/pagamento")}
                className="flex w-full items-center justify-between border-t border-line bg-[#FAFAFA] px-5 py-5 text-left text-[19px] text-muted"
              >
                1x de {brl(t.total)}
                <ChevronRight className="h-5 w-5 text-ink" />
              </button>
            ) : (
              <p className="border-t border-line bg-[#FAFAFA] px-5 py-5 text-[18px] text-muted">Aprovação automática</p>
            )}
          </div>
        </section>

        {t.hasDiscount && (
        <section className="mt-9">
          <div className="flex items-center gap-4">
            <Lock className="h-8 w-8 shrink-0 text-ink" />
            <div className="flex-1">
              <p className="text-[21px] text-ink">Cupons bloqueados</p>
              <p className="text-[18px] text-muted">Item já tem desconto aplicado</p>
            </div>
            <button onClick={() => setCouponInfo((v) => !v)} className="text-[19px] font-medium text-brand">Ver</button>
          </div>
          {couponInfo && (
            <p className="mt-3 rounded-xl bg-soft p-4 text-[16px] text-muted">
              Os itens deste subpedido já estão com preço promocional e não acumulam com cupons.
            </p>
          )}
        </section>
        )}

        <section className="mt-10">
          <h3 className="flex items-center gap-2 text-[22px] font-medium text-ink">
            Começou o Teleton 2026
            <button
              aria-label="Mais informações"
              onClick={() => setTeletonInfo((v) => !v)}
              className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-sm font-bold text-white"
            >?</button>
          </h3>
          <p className="mt-1 text-[18px] text-muted">Opção disponível apenas para pagamentos no cartão de crédito à vista</p>
          {teletonInfo && (
            <p className="mt-3 rounded-xl bg-soft p-4 text-[16px] text-muted">
              Doe junto com o seu pedido. A doação só aparece quando o pagamento é no cartão de crédito à vista.
            </p>
          )}
        </section>

        <section className="mt-10">
          <h3 className="text-[22px] font-medium text-ink">Resumo de valores</h3>
          <dl className="mt-4 space-y-3 text-[18px]">
            <div className="flex justify-between text-muted">
              <dt>Total dos itens</dt>
              <dd>
                {t.hasDiscount && <span className="mr-2 line-through">{brl(t.original)}</span>}
                <span className="text-ink">{brl(t.subtotal)}</span>
              </dd>
            </div>
            <div className="flex justify-between text-muted">
              <dt>Entrega</dt>
              <dd className="text-ink">{brl(t.fee)}</dd>
            </div>
            <div className="flex justify-between text-[21px] font-medium text-ink">
              <dt>Total</dt>
              <dd>{brl(t.total)}</dd>
            </div>
          </dl>

          {t.savings > 0 && (
            <button
              onClick={() => setSavingsOpen((v) => !v)}
              className="mt-5 w-full rounded-2xl border border-line px-4 py-4 text-[19px] text-saving"
              aria-expanded={savingsOpen}
            >
              <span className="flex items-center justify-center gap-2">
                Economia de {brl(t.savings)}
                <ChevronDown className={`h-4 w-4 transition ${savingsOpen ? "rotate-180" : ""}`} />
              </span>
              {savingsOpen && (
                <span className="mt-3 flex justify-between border-t border-line pt-3 text-[16px] text-muted">
                  <span>Promoção do item</span>
                  <span className="text-saving">− {brl(t.savings)}</span>
                </span>
              )}
            </button>
          )}
        </section>

        <section className="mt-10">
          <div className="flex items-center gap-4">
            <Receipt className="h-8 w-8 shrink-0 text-ink" />
            <div className="flex-1">
              <p className="text-[21px] text-ink">CPF na nota</p>
              <p className="text-[18px] text-muted">{cpfValid ? cpf : "Opcional"}</p>
            </div>
            <button onClick={() => setEditCpf((v) => !v)} className="text-[19px] font-medium text-brand">
              {cpfValid ? "Alterar" : "Adicionar"}
            </button>
          </div>
          {editCpf && (
            <div className="mt-4 flex gap-3">
              <input
                inputMode="numeric"
                placeholder="000.000.000-00"
                value={cpf}
                onChange={(e) => setCpf(maskCpf(e.target.value))}
                className="h-14 flex-1 rounded-xl border border-line px-4 text-[18px] outline-none focus:border-ink"
              />
              <button
                disabled={!cpfValid}
                onClick={() => setEditCpf(false)}
                className="rounded-xl bg-ink px-5 font-semibold text-white disabled:bg-line disabled:text-muted"
              >
                Salvar
              </button>
            </div>
          )}
        </section>
      </Screen>

      {/* Bottom sheet "Revise o seu pedido" */}
      <Sheet open={reviewOpen} onClose={() => !submitting && setReviewOpen(false)}>
        <h3 className="mb-8 text-center text-[27px] font-medium text-ink">Revise o seu pedido</h3>
        <ul className="space-y-7">
          <li className="flex items-center gap-5">
            <Bike className="h-8 w-8 shrink-0 text-ink" />
            <div>
              <p className="text-[21px] text-ink">Entrega hoje</p>
              <p className="text-[18px] text-muted">{current.eta.replace("min", " min")}</p>
            </div>
          </li>
          <li className="flex items-center gap-5">
            <Pin className="h-8 w-8 shrink-0 text-ink" />
            <div className="min-w-0">
              <p className="truncate text-[21px] text-ink">{address.street}</p>
              <p className="text-[18px] text-muted">{address.complement}</p>
            </div>
          </li>
          {t.hasDiscount && (
            <li className="flex items-center gap-5">
              <Lock className="h-8 w-8 shrink-0 text-ink" />
              <div>
                <p className="text-[21px] text-ink">Cupons bloqueados</p>
                <p className="text-[18px] text-muted">Item já tem desconto aplicado</p>
              </div>
            </li>
          )}
          <li className="flex items-center gap-5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center"><MethodIcon method={payment} /></span>
            <div className="flex flex-1 items-end justify-between">
              <div>
                <p className="text-[21px] text-ink">Pagamento pelo app</p>
                <p className="text-[18px] text-muted">{meta.label}</p>
              </div>
              <p className="text-[18px] text-muted">{brl(t.total)}</p>
            </div>
          </li>
        </ul>

        {error && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-3 text-[15px] text-brand-dark">{error}</p>}

        <div className="mt-8">
          <PrimaryButton onClick={placeOrder} loading={submitting}>Fazer pedido</PrimaryButton>
        </div>
        <button
          disabled={submitting}
          onClick={() => setReviewOpen(false)}
          className="mt-3 h-14 w-full text-[19px] font-medium text-brand"
        >
          Voltar
        </button>
      </Sheet>
    </>
  );
}
