import type { OrderView } from '../group-order/group-order.service.js';
import { UNTRUSTED_TAG } from './tool-envelope.js';

// Estado do pedido em grupo montado pelo código. Vai em dois lugares:
//  - anexado à mensagem do usuário a cada turno (o LLM não precisa adivinhar nem lembrar o cartId
//    quando a janela de histórico corta o começo da conversa);
//  - como resumo "🧾 Seu pedido" no fim da resposta quando o carrinho mudou no turno.
// Nomes de itens, lojas e participantes vêm do catálogo/usuário: entram como dado não confiável.

const MAX_STATE_CHARS = 3000;

function cartLines(view: OrderView): string[] {
  return (view.carts ?? []).flatMap((cart) => [
    `- ${cart.restaurant} (cartId ${cart.ifood_cart_id}, ${cart.status}): subtotal ${cart.subtotal}, total ${cart.total}`,
    ...cart.items.map(
      (i) =>
        `  • ${i.quantity}x ${i.name} — ${i.unit_price} (cartItemId ${i.item_id}; paga: ${i.payer ?? 'não definido'})`,
    ),
  ]);
}

export function orderStateBlock(view: OrderView, ownerName?: string): string {
  const lines: string[] = [];
  if (ownerName) {
    lines.push(
      `Dono da conversa: ${ownerName.replace(/\s+/g, ' ').trim().slice(0, 60)} (nome do perfil no app de mensagens)`,
    );
  }
  if (!view.order) {
    lines.push('Nenhum pedido em grupo em andamento.');
  } else {
    lines.push(`Pedido ${view.order.id}: ${view.order.status}`);
    lines.push(
      `Participantes: ${view.participants?.length ? view.participants.join(', ') : 'nenhum'}`,
    );
    const carts = cartLines(view);
    lines.push(carts.length ? 'Carrinhos:' : 'Carrinhos: nenhum');
    lines.push(...carts);
    for (const p of view.amounts_preview ?? []) {
      lines.push(`Prévia: ${p.participant} paga ${p.total} (${p.cart})`);
    }
    for (const p of view.payments ?? []) {
      lines.push(`Pagamento: ${p.participant} ${p.amount} — ${p.status}`);
    }
    if (view.problems?.length) {
      lines.push(`Problemas: ${view.problems.join(' ')}`);
    }
  }
  for (const o of view.awaiting_finalization) {
    lines.push(
      `Pedido ${o.order_id} pago, aguardando envio (submitOrder): ${o.carts.map((c) => `${c.restaurant} (cartId ${c.ifood_cart_id})`).join(', ')}`,
    );
  }
  let body = lines.join('\n');
  if (body.length > MAX_STATE_CHARS) {
    body = `${body.slice(0, MAX_STATE_CHARS)}\n[… estado encurtado; chame group_get_order para o resto]`;
  }
  body = body.replaceAll(`</${UNTRUSTED_TAG}`, `<\\/${UNTRUSTED_TAG}`);
  return `<${UNTRUSTED_TAG} ferramenta="estado_do_pedido">\nEstado atual do pedido em grupo (lido do sistema agora, vale mais que o histórico):\n${body}\n</${UNTRUSTED_TAG}>`;
}

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');

// Resumo para o usuário. null quando não há carrinho ou quando a resposta do modelo já cita todos
// os itens (dois resumos seguidos na mesma mensagem confundem; os valores dela já passaram pelo
// validador de R$).
export function orderSummary(view: OrderView, reply = ''): string | null {
  const carts = view.carts ?? [];
  if (!view.order || carts.length === 0) return null;
  const text = normalize(reply);
  const names = carts.flatMap((c) => c.items.map((i) => normalize(i.name)));
  if (names.length > 0 && names.every((n) => text.includes(n))) return null;
  const lines = carts.flatMap((cart) => [
    `**${cart.restaurant}** — total ${cart.total}`,
    ...cart.items.map(
      (i) =>
        `• ${i.quantity}x ${i.name} — ${i.unit_price}${i.payer ? ` (${i.payer})` : ''}`,
    ),
  ]);
  return ['🧾 **Seu pedido**', ...lines].join('\n');
}
