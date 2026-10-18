"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy } from "@/components/icons";
import { PlainHeader, PrimaryButton, Screen } from "@/components/ui";
import { brl, formatTimer } from "@/lib/format";
import { PIX_TTL_SECONDS } from "@/lib/mock";
import { getChargeStatus, hasBackend, payCharge } from "@/services/api";
import { useOrder } from "@/store/order";

function PixIllustration() {
  return (
    <svg viewBox="0 0 340 340" className="mx-auto h-[270px] w-[270px]" aria-hidden>
      <circle cx="170" cy="170" r="150" fill="#FDE3E6" />
      <rect x="118" y="62" width="104" height="170" rx="16" fill="#fff" stroke="#2b2b2b" strokeWidth="6" />
      <g fill="#6CC1B2">
        <rect x="150" y="104" width="22" height="22" rx="5" transform="rotate(45 161 115)" />
        <rect x="170" y="124" width="22" height="22" rx="5" transform="rotate(45 181 135)" />
        <rect x="150" y="144" width="22" height="22" rx="5" transform="rotate(45 161 155)" />
        <rect x="130" y="124" width="22" height="22" rx="5" transform="rotate(45 141 135)" />
      </g>
      <path d="M92 230c-14-22-8-62 20-88l20 12-8 58 28 14z" fill="#C25A86" />
      <path d="M150 238c26-26 78-16 98-2 10 8 4 22-8 26-22 8-60 12-92-6z" fill="#C25A86" />
      <path d="M200 152c20-18 38-14 44-4 6 12-8 24-30 40z" fill="#C25A86" />
      <g fill="none" stroke="#EA1D2C" strokeWidth="6" strokeLinecap="round">
        <path d="M272 124a34 34 0 11-18-30" />
        <path d="M254 112v16l-12 6" />
      </g>
    </svg>
  );
}

export default function PixPage() {
  const router = useRouter();
  const charge = useOrder((s) => s.charge);
  const orderId = useOrder((s) => s.orderId);
  const sub = useOrder((s) => s.subOrders.find((x) => x.id === s.charge?.subOrderId) ?? null);
  const setSubOrderStatus = useOrder((s) => s.setSubOrderStatus);
  const token = useOrder((s) => s.token);

  const [remaining, setRemaining] = useState(PIX_TTL_SECONDS);
  const [copied, setCopied] = useState(false);
  const [help, setHelp] = useState(false);
  const [simulating, setSimulating] = useState(false);

  const confirmPaid = useCallback(() => {
    if (!charge) return;
    setSubOrderStatus(charge.subOrderId, "paid", "Você");
    router.push("/pedido-confirmado");
  }, [charge, setSubOrderStatus, router]);

  // sem cobrança (acesso direto à URL) volta para o início do fluxo
  useEffect(() => {
    if (!charge?.pixCode) router.replace("/sacola");
  }, [charge, router]);

  useEffect(() => {
    if (!charge?.expiresAt) return;
    const tick = () => setRemaining(Math.max(0, Math.round((charge.expiresAt! - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [charge]);

  const expired = remaining === 0;

  // Pix pago no app do banco: o mock do iFood marca a cobrança como paga (e publica o evento)
  useEffect(() => {
    if (!hasBackend || !token || !charge?.pixCode || expired) return;
    const id = setInterval(() => {
      getChargeStatus(token).then((status) => status === "paid" && confirmPaid()).catch(() => undefined);
    }, 3000);
    return () => clearInterval(id);
  }, [token, charge, expired, confirmPaid]);
  const progress = Math.max(0, Math.min(1, remaining / PIX_TTL_SECONDS));

  // código vencido: o subpedido volta a ficar disponível para ser pago
  useEffect(() => {
    if (expired && charge && sub?.status === "awaiting_payment") setSubOrderStatus(charge.subOrderId, "open");
  }, [expired, charge, sub?.status, setSubOrderStatus]);

  const copy = useCallback(async () => {
    if (!charge?.pixCode || expired) return;
    try {
      await navigator.clipboard.writeText(charge.pixCode);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = charge.pixCode;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [charge, expired]);

  if (!charge?.pixCode) return null;

  return (
    <Screen
      header={
        <PlainHeader
          title="PAGAMENTO"
          onBack={() => router.push("/checkout")}
          right={<button onClick={() => setHelp((v) => !v)}>Ajuda</button>}
        />
      }
      footer={
        expired ? (
          <PrimaryButton onClick={() => router.push("/checkout")}>Gerar novo código</PrimaryButton>
        ) : (
          <PrimaryButton onClick={copy}>{copied ? "Código copiado!" : "Copiar código"}</PrimaryButton>
        )
      }
    >
      <PixIllustration />

      <h2 className="mt-2 text-center text-[25px] font-medium text-ink">
        {expired ? "O tempo para pagar acabou" : "Pedido aguardando pagamento"}
      </h2>
      <p className="mx-auto mt-3 max-w-[340px] text-center text-[18px] leading-snug text-ink">
        {expired
          ? "Gere um novo código Pix para pagar este subpedido."
          : "Copie o código abaixo e utilize o Pix Copia e Cola no aplicativo que você vai fazer o pagamento:"}
      </p>

      <button
        onClick={copy}
        disabled={expired}
        aria-label="Copiar código Pix"
        className="mt-6 flex w-full items-center justify-between gap-3 rounded-2xl border border-dashed border-line px-5 py-5 text-left disabled:opacity-50"
      >
        <span className="truncate text-[22px] text-ink">{charge.pixCode}</span>
        {copied ? <Check className="h-7 w-7 shrink-0 text-saving" /> : <Copy className="h-7 w-7 shrink-0 text-brand" />}
      </button>

      <p className="mt-5 text-[18px] text-muted">O tempo para você pagar acaba em:</p>
      <p className="mt-1 text-[32px] font-medium text-ink" role="timer" aria-live="off">{formatTimer(remaining)}</p>
      <div className="mt-3 h-1.5 w-full rounded-full bg-line">
        <div className="h-full rounded-full bg-brand transition-[width] duration-1000 ease-linear" style={{ width: `${progress * 100}%` }} />
      </div>

      <button onClick={() => setHelp((v) => !v)} className="mx-auto mt-9 block text-[20px] font-medium text-brand">
        Como funciona
      </button>
      {help && (
        <ol className="mt-4 list-decimal space-y-2 rounded-2xl bg-soft p-5 pl-9 text-[16px] text-ink">
          <li>Copie o código Pix.</li>
          <li>Abra o app do seu banco e escolha pagar com Pix Copia e Cola.</li>
          <li>Cole o código e confirme o pagamento.</li>
          <li>A aprovação é automática e a loja começa a preparar o subpedido.</li>
        </ol>
      )}

      {sub && (
        <section className="mt-8 rounded-2xl border border-line p-5">
          <div className="flex items-center gap-4">
            <div className={`flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br ${sub.restaurant.accent} text-xl`}>{sub.restaurant.emoji}</div>
            <div className="min-w-0">
              <p className="truncate text-[19px] text-ink">{sub.restaurant.name}</p>
              <p className="text-[14px] text-muted">{sub.label} • pedido {orderId}</p>
            </div>
          </div>
          <p className="mt-4 border-t border-line pt-4 text-[16px] text-muted">Total {brl(charge.total)}</p>
        </section>
      )}

      {process.env.NODE_ENV !== "production" && (
        <button
          disabled={simulating || expired}
          onClick={async () => {
            if (hasBackend && token) {
              setSimulating(true);
              try {
                await payCharge(token);
              } catch {
                // já paga (ex.: corrida com o polling) ou recusada: o status real decide
                if ((await getChargeStatus(token).catch(() => null)) !== "paid") return setSimulating(false);
              }
            }
            confirmPaid();
          }}
          className="mt-8 w-full rounded-xl border border-dashed border-muted py-3 text-[15px] text-muted"
        >
          [dev] Simular pagamento aprovado
        </button>
      )}
    </Screen>
  );
}
