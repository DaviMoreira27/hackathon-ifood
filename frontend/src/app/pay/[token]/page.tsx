"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PlainHeader, Screen } from "@/components/ui";
import { rememberToken } from "@/lib/linked-order";
import { fetchOrderByToken, hasBackend } from "@/services/api";
import { useOrder } from "@/store/order";

// Entrada pelo link enviado no Telegram: carrega o pedido do token e abre a sacola.
export default function PayLinkPage() {
  const router = useRouter();
  const { token } = useParams<{ token: string }>();
  const load = useOrder((s) => s.load);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!hasBackend) {
      setError("Backend não configurado (NEXT_PUBLIC_API_URL).");
      return;
    }
    let cancelled = false;
    fetchOrderByToken(token)
      .then((view) => {
        if (cancelled) return;
        rememberToken(token);
        load(token, view);
        router.replace("/sacola");
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Erro ao carregar o pedido"));
    return () => { cancelled = true; };
  }, [token, load, router]);

  return (
    <Screen header={<PlainHeader title="PAGAMENTO" />}>
      {error ? (
        <p role="alert" className="mt-16 rounded-xl bg-red-50 p-4 text-center text-[17px] text-brand-dark">{error}</p>
      ) : (
        <div className="mt-24 flex flex-col items-center gap-4 text-[17px] text-muted">
          <span className="h-8 w-8 animate-spin rounded-full border-[3px] border-line border-t-brand" />
          Carregando pedido...
        </div>
      )}
    </Screen>
  );
}
