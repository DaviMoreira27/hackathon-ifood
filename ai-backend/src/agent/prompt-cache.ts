import type {
  ContentBlockParam,
  MessageParam,
  TextBlockParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages.js';

// Prompt caching: o loop reenvia ferramentas + system + histórico a cada rodada (até 10 por
// mensagem). Com breakpoints no fim das ferramentas, do system e da última mensagem, cada rodada
// lê o prefixo anterior do cache (~10% do custo) em vez de pagá-lo de novo.
// Tudo é copiado: o cache_control nunca vai para o array que é gravado no histórico.
const EPHEMERAL = { type: 'ephemeral' } as const;

export function cachedTools(tools: Tool[]): Tool[] {
  if (tools.length === 0) return tools;
  const last = tools.length - 1;
  return tools.map((t, i) =>
    i === last ? { ...t, cache_control: EPHEMERAL } : t,
  );
}

// `extra` é o bloco que muda por usuário (ex.: restrições alimentares): fica depois do breakpoint,
// para o prompt fixo continuar vindo do cache.
export function cachedSystem(
  system: string,
  extra?: string | null,
): TextBlockParam[] {
  const blocks: TextBlockParam[] = [
    { type: 'text', text: system, cache_control: EPHEMERAL },
  ];
  if (extra) blocks.push({ type: 'text', text: extra });
  return blocks;
}

export function cachedMessages(messages: MessageParam[]): MessageParam[] {
  if (messages.length === 0) return messages;
  const lastMessage = messages[messages.length - 1];
  const blocks: ContentBlockParam[] =
    typeof lastMessage.content === 'string'
      ? [{ type: 'text', text: lastMessage.content }]
      : [...lastMessage.content];
  const lastBlock = blocks[blocks.length - 1];
  if (!lastBlock) return messages;
  blocks[blocks.length - 1] = {
    ...lastBlock,
    cache_control: EPHEMERAL,
  } as ContentBlockParam;
  return [...messages.slice(0, -1), { ...lastMessage, content: blocks }];
}
