import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';

// Fatos que importam (preços, ids, ações executadas) não podem depender do texto do LLM. Este
// módulo confere a resposta e as chamadas contra o que as ferramentas devolveram de verdade.

const CORRECTION_PREFIX = 'Sistema (verificação automática, não é o usuário):';

// Devolvida ao modelo (como mensagem de user) quando a resposta final não passa na checagem.
export function correctionNote(amounts: Money[], claims: string[]): string {
  const problems = [
    amounts.length
      ? `os valores ${amounts.map((a) => a.text).join(', ')} não aparecem em nenhum resultado de ferramenta`
      : null,
    claims.length
      ? `a resposta diz que você fez algo (${claims.join(', ')}) sem a ferramenta correspondente ter dado certo neste turno`
      : null,
  ].filter(Boolean);
  return `${CORRECTION_PREFIX} ${problems.join('; ')}. Escreva de novo a resposta final ao usuário, do zero, como se fosse a primeira: use só valores que vieram das ferramentas (ou consulte de novo) e não afirme ações que não foram executadas com sucesso. O usuário não viu a versão anterior: não mencione esta verificação, correções, revisões nem respostas anteriores.`;
}

// Devolvida quando o modelo encerra o turno sem nenhum texto para o usuário.
export function emptyReplyNote(): string {
  return `${CORRECTION_PREFIX} sua resposta veio sem texto para o usuário. Escreva agora a resposta a ele, com base no que as ferramentas devolveram, sem mencionar esta verificação.`;
}

// ─── corpus: tudo o que veio de ferramentas, do sistema ou do usuário ────────

// Textos dos resultados de ferramentas e das mensagens do usuário na conversa (histórico + turno).
export function factCorpus(
  messages: MessageParam[],
  extra: string[] = [],
): string {
  const parts: string[] = [...extra];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') {
      parts.push(message.content);
      continue;
    }
    for (const block of message.content) {
      // A nota de correção cita os valores rejeitados: não pode virar fonte deles.
      if (block.type === 'text' && !block.text.startsWith(CORRECTION_PREFIX)) {
        parts.push(block.text);
      }
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        parts.push(block.content);
      }
    }
  }
  return parts.join('\n');
}

// ─── valores em R$ ───────────────────────────────────────────────────────────

const BRL_IN_REPLY = /R\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/g;
const NUMBER_TOKEN = /\d[\d.,]*\d|\d/g;

function brlToCents(reais: string, decimals = ''): number {
  return (
    Number(reais.replace(/\./g, '')) * 100 + Number(decimals.padEnd(2, '0'))
  );
}

// Todo número do corpus, em todas as leituras plausíveis: 42.9 / 42,90 / 1.234,56 / 4290 (centavos).
export function knownCents(corpus: string): Set<number> {
  const known = new Set<number>();
  for (const token of corpus.match(NUMBER_TOKEN) ?? []) {
    const en = Number(token.replace(/,/g, ''));
    const br = Number(token.replace(/\./g, '').replace(',', '.'));
    for (const value of [en, br]) {
      if (Number.isFinite(value)) known.add(Math.round(value * 100));
    }
    if (/^\d+$/.test(token)) known.add(Number(token));
  }
  return known;
}

export interface Money {
  text: string;
  cents: number;
}

// Valores R$ da resposta que não aparecem em nenhuma ferramenta, mensagem do usuário ou texto do
// sistema. R$ 0,00 sempre vale (entrega grátis).
export function unknownAmounts(reply: string, known: Set<number>): Money[] {
  const out: Money[] = [];
  for (const m of reply.matchAll(BRL_IN_REPLY)) {
    const cents = brlToCents(m[1], m[2] ?? '');
    if (cents === 0 || known.has(cents)) continue;
    if (!out.some((o) => o.text === m[0])) out.push({ text: m[0], cents });
  }
  return out;
}

export function stripAmounts(reply: string, amounts: Money[]): string {
  let out = reply;
  for (const a of amounts) out = out.replaceAll(a.text, '(valor a confirmar)');
  return out;
}

// ─── ids usados em escritas ──────────────────────────────────────────────────

const ID_KEY = /(^id$|Id$|_id$)/;

// Pares (campo, valor) de todo campo "...Id" do input, em qualquer profundidade.
export function idsInInput(
  value: unknown,
  key = '',
  out: Array<{ key: string; value: string }> = [],
  depth = 0,
): Array<{ key: string; value: string }> {
  if (depth > 8) return out;
  if (Array.isArray(value)) {
    value.forEach((v) => idsInInput(v, key, out, depth + 1));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value))
      idsInInput(v, k, out, depth + 1);
  } else if (
    ID_KEY.test(key) &&
    (typeof value === 'string' || typeof value === 'number')
  ) {
    const v = String(value).trim();
    if (v) out.push({ key, value: v });
  }
  return out;
}

// Ids da chamada que nunca apareceram num resultado de ferramenta (ou texto do sistema) da conversa.
export function unseenIds(
  input: unknown,
  corpus: string,
): Array<{ key: string; value: string }> {
  return idsInInput(input).filter((id) => !corpus.includes(id.value));
}

// ─── "disse que fez" ─────────────────────────────────────────────────────────

// Frases de ação concluída (1ª pessoa, passado) e as ferramentas que precisam ter dado certo no
// turno para a frase ser verdade. Conservador de propósito: só o que tem efeito real.
// Palavra inteira com acento: \b do JS não trata "í" como letra.
const word = (alternatives: string) =>
  `(?<!\\p{L})(?:${alternatives})(?!\\p{L})`;
const near = (verbs: string, nouns: string) =>
  new RegExp(`${word(verbs)}[^.\\n]{0,40}${word(nouns)}`, 'giu');
// "Não adicionei", "ainda não coloquei nada", "nem adicionei": negação logo antes, na mesma oração.
const NEGATION = new RegExp(
  `${word('não|nao|nem|nunca|nada')}[^.!?,;\\n]{0,25}$`,
  'iu',
);

const CLAIMS: Array<{ pattern: RegExp; tools: RegExp; label: string }> = [
  {
    pattern: new RegExp(word('adicionei'), 'giu'),
    tools: /^(addItemToCart|updateCartItem|createCart)$/,
    label: 'adicionar item',
  },
  {
    pattern: near('coloquei|incluí|inclui', 'carrinho|pedido'),
    tools: /^(addItemToCart|updateCartItem|createCart)$/,
    label: 'adicionar item',
  },
  {
    pattern: near('removi|tirei|excluí|exclui', 'carrinho|pedido'),
    tools: /^(removeItemFromCart|updateCartItem)$/,
    label: 'remover item',
  },
  {
    pattern: near('apliquei|ativei', 'cupom|voucher|desconto'),
    tools: /^setVoucher$/,
    label: 'aplicar cupom',
  },
  {
    pattern: near('enviei|finalizei', 'pedido'),
    tools: /^submitOrder$/,
    label: 'enviar o pedido',
  },
  {
    pattern: near('gerei|criei', 'links?|cobranças?|cobrancas?'),
    tools: /^group_confirm_order$/,
    label: 'gerar os links de pagamento',
  },
];

// Ações afirmadas na resposta sem a ferramenta correspondente ter dado certo neste turno.
export function unbackedClaims(reply: string, succeeded: string[]): string[] {
  const affirmed = (pattern: RegExp) =>
    [...reply.matchAll(pattern)].some(
      (m) => !NEGATION.test(reply.slice(Math.max(0, m.index - 40), m.index)),
    );
  const labels = CLAIMS.filter(
    (c) => affirmed(c.pattern) && !succeeded.some((t) => c.tools.test(t)),
  ).map((c) => c.label);
  return [...new Set(labels)];
}
