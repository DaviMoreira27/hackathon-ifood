import { PIX_TTL_SECONDS } from "@/lib/mock";
import type { Charge, CreatePaymentPayload } from "@/lib/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakePixCode() {
  const rand = Math.random().toString(36).slice(2, 12).toUpperCase();
  return `00020101021226850014br.gov.bcb.pix2563pix.example.com/qr/v2/${rand}5204000053039865802BR5920SANDUWISH SMASH HOUSE6009SAO PAULO62070503***6304ABCD`;
}

/**
 * Cria a cobrança de UM subpedido.
 * Espera do NestJS: POST {API_URL}/orders/:orderId/sub-orders/:subOrderId/payments -> Charge
 * O backend deve responder 409 se o subpedido já estiver pago/aguardando pagamento.
 * Sem NEXT_PUBLIC_API_URL, responde com mock.
 */
export async function createPayment(payload: CreatePaymentPayload, total: number): Promise<Charge> {
  if (API_URL) {
    const { orderId, subOrderId, ...body } = payload;
    const res = await fetch(`${API_URL}/orders/${orderId}/sub-orders/${subOrderId}/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 409) throw new Error("Este subpedido já foi pago por outra pessoa.");
    if (!res.ok) throw new Error("Não foi possível iniciar o pagamento");
    return res.json();
  }

  await wait(700);
  const isPix = payload.payment === "pix";
  return {
    id: `pg_${Math.floor(1000 + Math.random() * 9000)}`,
    subOrderId: payload.subOrderId,
    total,
    payment: payload.payment,
    pixCode: isPix ? fakePixCode() : undefined,
    expiresAt: isPix ? Date.now() + PIX_TTL_SECONDS * 1000 : undefined,
  };
}
