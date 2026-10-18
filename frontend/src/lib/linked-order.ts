"use client";
import { useEffect } from "react";
import { fetchOrderByToken, hasBackend } from "@/services/api";
import { useOrder } from "@/store/order";

const KEY = "ifood:payToken";

export function rememberToken(token: string) {
  try { sessionStorage.setItem(KEY, token); } catch { /* sem storage: só não sobrevive ao F5 */ }
}

function storedToken() {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}

// Recarrega o pedido do link (status atualizados por outros pagadores; também depois de um F5).
export function useLinkedOrder() {
  const load = useOrder((s) => s.load);
  useEffect(() => {
    if (!hasBackend) return;
    const token = useOrder.getState().token ?? storedToken();
    if (!token) return;
    let cancelled = false;
    fetchOrderByToken(token)
      .then((view) => !cancelled && load(token, view))
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [load]);
}
