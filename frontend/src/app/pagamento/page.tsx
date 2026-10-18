"use client";
import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Cards, ChevronRight, GPayLogo, IfoodPago, PixLogo, Wallet } from "@/components/icons";
import { PlainHeader, Radio, Screen } from "@/components/ui";
import { brl } from "@/lib/format";
import { useOrder } from "@/store/order";
import type { PaymentMethod } from "@/lib/types";

function Option({
  icon, title, subtitle, badge, selected, disabled, onClick, trailing,
}: {
  icon: ReactNode; title: string; subtitle: string; badge?: string;
  selected?: boolean; disabled?: boolean; onClick?: () => void; trailing?: ReactNode;
}) {
  return (
    <button
      role="radio"
      aria-checked={!!selected}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-4 rounded-3xl border px-5 py-5 text-left transition ${
        selected ? "border-[1.5px] border-black" : "border-line"
      } ${disabled ? "opacity-50" : "active:bg-soft"}`}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[21px] text-ink">{title}</span>
        <span className="block text-[18px] text-muted">{subtitle}</span>
        {badge && (
          <span className="mt-2 inline-block rounded-full bg-[#E3F6EA] px-3 py-1 text-[15px] text-saving">{badge}</span>
        )}
      </span>
      {trailing ?? <Radio selected={!!selected} />}
    </button>
  );
}

export default function PagamentoPage() {
  const router = useRouter();
  const { payment, setPayment } = useOrder();
  const [notice, setNotice] = useState("");

  const choose = (m: PaymentMethod) => {
    setPayment(m);
    router.back(); // volta ao checkout com a forma escolhida
  };

  return (
    <Screen
      header={
        <>
          <PlainHeader onBack={() => router.back()} title={<IfoodPago className="text-[24px]" />} />
          <div className="mt-3 border-b border-line text-center text-[19px]" role="tablist">
            <span role="tab" aria-selected className="-mb-px inline-block w-full border-b-2 border-pago py-5 font-medium text-pago">
              Pagar pelo app
            </span>
          </div>
        </>
      }
    >
      <div className="mt-8 space-y-4" role="radiogroup" aria-label="Forma de pagamento pelo app">
        <Option
          icon={<GPayLogo />}
          title="Google Pay"
          subtitle="Pague com Google"
          badge="Parcele seu pedido"
          selected={payment === "google_pay"}
          onClick={() => choose("google_pay")}
        />
        <Option
          icon={<PixLogo size={40} />}
          title="Pix"
          subtitle="Aprovação automática"
          selected={payment === "pix"}
          onClick={() => choose("pix")}
        />
        <div className="relative">
          <span className="absolute right-0 top-0 z-10 rounded-bl-xl rounded-tr-3xl bg-soft px-4 py-1 text-[15px] font-medium text-ink">Novo</span>
          <Option
            icon={<Cards className="h-9 w-9 text-ink" />}
            title="Combinar pagamentos"
            subtitle="Escolha 2 formas de pagamento"
            trailing={<ChevronRight className="h-5 w-5 text-ink" />}
            onClick={() => setNotice("Combinar pagamentos ainda não está disponível nesta simulação.")}
          />
        </div>

        <button
          onClick={() => setNotice("Adicionar cartão ainda não está disponível nesta simulação.")}
          className="mx-auto block py-6 text-[21px] font-medium text-pago"
        >
          Adicionar novo cartão
        </button>

        <Option
          disabled
          icon={<Wallet className="h-9 w-9 text-muted" />}
          title="Saldo app iFood"
          subtitle={`${brl(0)} • Saldo insuficiente`}
          trailing={<span />}
        />
        {notice && <p role="status" className="rounded-xl bg-soft p-4 text-[16px] text-muted">{notice}</p>}
      </div>
    </Screen>
  );
}
