import { PIX_TTL_SECONDS } from "@/lib/mock";
import { buildPixCode } from "@/lib/pix";
import type { Charge, CreatePaymentPayload, PayerOrderView } from "@/lib/types";

// Mock do iFood (ifood-backend): pedido do link, cobrança e pagamento (o evento sai de lá).
const API_URL = process.env.NEXT_PUBLIC_API_URL;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const hasBackend = Boolean(API_URL);

function fakePixCode() {
  const rand = Math.random().toString(36).slice(2, 12).toUpperCase();
  return `00020101021226850014br.gov.bcb.pix2563pix.example.com/qr/v2/${rand}5204000053039865802BR5920SANDUWISH SMASH HOUSE6009SAO PAULO62070503***6304ABCD`;
}

type ChargeStatus = "pending" | "paid" | "cancelled" | "expired";
interface ProviderCharge {
  id: string;
  amountCents: number;
  status: ChargeStatus;
  expiresAt: string;
}

const STATUS_ERROR: Record<Exclude<ChargeStatus, "pending">, string> = {
  paid: "Este subpedido já foi pago.",
  cancelled: "Este link de pagamento foi cancelado. Peça um novo ao dono do pedido.",
  expired: "Este link de pagamento venceu. Peça um novo ao dono do pedido.",
};

/** Pedido do link de pagamento: GET {API_URL}/orders/by-token/:token */
export async function fetchOrderByToken(token: string): Promise<PayerOrderView> {
  const res = await fetch(`${API_URL}/orders/by-token/${encodeURIComponent(token)}`, { cache: "no-store" });
  if (res.status === 404 || res.status === 410) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body?.message === "string" ? body.message : "Link de pagamento inválido.");
  }
  if (!res.ok) throw new Error("Não foi possível carregar o pedido");
  return res.json();
}

async function getCharge(token: string): Promise<ProviderCharge> {
  const res = await fetch(`${API_URL}/payments/by-token/${encodeURIComponent(token)}`, { cache: "no-store" });
  if (!res.ok) throw new Error("Link de pagamento inválido");
  return res.json();
}

export async function getChargeStatus(token: string): Promise<ChargeStatus> {
  return (await getCharge(token)).status;
}

/** Paga a cobrança no mock do iFood: POST {API_URL}/payments/by-token/:token/pay */
export async function payCharge(token: string): Promise<void> {
  const res = await fetch(`${API_URL}/payments/by-token/${encodeURIComponent(token)}/pay`, { method: "POST" });
  if (res.ok) return;
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    const status = body?.status as Exclude<ChargeStatus, "pending"> | undefined;
    throw new Error((status && STATUS_ERROR[status]) || "Este subpedido não pode mais ser pago.");
  }
  throw new Error("Não foi possível concluir o pagamento");
}

/**
 * Inicia o pagamento de UM subpedido. A cobrança já existe no mock do iFood (criada quando o dono
 * confirmou o pedido); o token do link é a credencial. Google Pay paga na hora; Pix gera o código e
 * fica aguardando. Sem backend configurado, responde com mock.
 */
export async function createPayment(payload: CreatePaymentPayload, total: number, token?: string | null): Promise<Charge> {
  if (hasBackend && token) {
    const charge = await getCharge(token);
    if (charge.status !== "pending") throw new Error(STATUS_ERROR[charge.status]);
    const isPix = payload.payment === "pix";
    if (!isPix) await payCharge(token);
    return {
      id: charge.id,
      subOrderId: payload.subOrderId,
      total: charge.amountCents / 100,
      payment: payload.payment,
      pixCode: isPix ? buildPixCode(charge.amountCents / 100, charge.id) : undefined,
      // o código Pix vence antes do link (nunca depois)
      expiresAt: isPix ? Math.min(Date.parse(charge.expiresAt), Date.now() + PIX_TTL_SECONDS * 1000) : undefined,
    };
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
