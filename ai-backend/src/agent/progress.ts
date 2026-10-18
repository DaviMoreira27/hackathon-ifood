// Etapa atual do turno, mostrada ao usuário enquanto o agente trabalha. Vem só dos nomes das
// ferramentas pedidas (nada do texto do LLM): é um rótulo fixo, escolhido pelo código.
const STEPS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /submit_?order|checkout/i, label: 'Enviando o pedido...' },
  { pattern: /^group_confirm_order$/, label: 'Gerando as cobranças...' },
  { pattern: /^group_/, label: 'Organizando o pedido em grupo...' },
  { pattern: /^diet_/, label: 'Conferindo as restrições alimentares...' },
  { pattern: /^compare_prices$/, label: 'Comparando preços...' },
  {
    pattern: /add|remove|update|create_?cart|set_?(voucher|cart)/i,
    label: 'Montando o carrinho...',
  },
  { pattern: /get_?cart/i, label: 'Conferindo o carrinho...' },
  { pattern: /search|recommend|offer/i, label: 'Buscando ofertas...' },
  { pattern: /merchant|item|menu|catalog/i, label: 'Olhando o cardápio...' },
  { pattern: /address/i, label: 'Conferindo o endereço...' },
  { pattern: /voucher|coupon/i, label: 'Procurando cupons...' },
  { pattern: /track|order/i, label: 'Consultando o pedido...' },
];

// Rótulo da etapa mais importante do lote (a ordem de STEPS é a prioridade).
export function progressLabel(toolNames: string[]): string | null {
  for (const step of STEPS) {
    if (toolNames.some((name) => step.pattern.test(name))) return step.label;
  }
  return toolNames.length ? 'Consultando o iFood...' : null;
}
