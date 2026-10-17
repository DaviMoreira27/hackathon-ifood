import type {
  ContentBlockParam,
  MessageParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages.js';
import type { Message, NewMessage } from '../messages/messages.service.js';

// Reconstrói a conversa do LLM a partir das linhas da tabela messages:
//   user      → texto do usuário
//   assistant → texto final, ou blocos (com tool_use) quando há payload
//   tool      → blocos tool_result (payload), que a API espera como mensagem de user
export function rowsToMessages(rows: Message[]): MessageParam[] {
  const out: MessageParam[] = [];
  let started = false;

  for (const row of rows) {
    if (!started) {
      // A janela de histórico pode cortar um turno no meio; só começamos num texto do usuário
      // para não deixar tool_result sem o tool_use correspondente.
      if (row.role !== 'user' || row.payload != null) continue;
      started = true;
    }

    if (row.role === 'user') {
      out.push({ role: 'user', content: row.content });
    } else if (row.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: (row.payload as ContentBlockParam[] | null) ?? row.content,
      });
    } else if (row.payload != null) {
      out.push({
        role: 'user',
        content: row.payload as ToolResultBlockParam[],
      });
    }
  }
  return out;
}

// Converte as mensagens geradas num turno (assistant / tool_result) em linhas para gravar.
export function messagesToRows(
  chatId: number,
  userId: number,
  turn: MessageParam[],
): NewMessage[] {
  const toolNames = new Map<string, string>();

  return turn.map((message): NewMessage => {
    const blocks = message.content as ContentBlockParam[];

    if (message.role === 'assistant') {
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      for (const b of toolUses) toolNames.set(b.id, b.name);
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return {
        chatId,
        userId,
        role: 'assistant',
        content:
          text ||
          (toolUses.length
            ? `[ferramentas: ${toolUses.map((b) => b.name).join(', ')}]`
            : '(sem texto)'),
        payload: toolUses.length ? blocks : null,
      };
    }

    const results = blocks.filter((b) => b.type === 'tool_result');
    return {
      chatId,
      userId,
      role: 'tool',
      content: results
        .map(
          (b) =>
            `${toolNames.get(b.tool_use_id) ?? b.tool_use_id} → ${typeof b.content === 'string' ? b.content : ''}`,
        )
        .join('\n'),
      payload: blocks,
    };
  });
}
