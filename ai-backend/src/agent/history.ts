import type {
  ContentBlockParam,
  MessageParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages.js';
import type { Message, NewMessage } from '../messages/messages.service.js';
import { shrinkToolResult } from './tool-policy.js';

// Reconstrói a conversa do LLM a partir das linhas da tabela messages:
//   user      → texto do usuário
//   assistant → texto final, ou blocos (com tool_use) quando há payload
//   tool      → blocos tool_result (payload), que a API espera como mensagem de user
// maxToolResultChars encurta resultados de ferramentas antigos (ver shrinkToolResult).
export function rowsToMessages(
  rows: Message[],
  maxToolResultChars = Infinity,
): MessageParam[] {
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
      // Blocos de raciocínio (thinking) de turnos anteriores não voltam ao modelo. A assinatura de
      // cada bloco amarra a conversa exata em que ele nasceu, e o histórico remontado do banco
      // muda entre mensagens (a janela desliza, resultados antigos são encurtados, a lista de
      // ferramentas muda): reenviá-los dá 400 em contas com a checagem ativa. Dentro do turno
      // atual o array só cresce, então os blocos novos continuam válidos.
      const blocks = (row.payload as ContentBlockParam[] | null)?.filter(
        (b) => b.type !== 'thinking' && b.type !== 'redacted_thinking',
      );
      out.push({
        role: 'assistant',
        content: blocks?.length ? blocks : row.content,
      });
    } else if (row.payload != null) {
      out.push({
        role: 'user',
        content: (row.payload as ToolResultBlockParam[]).map((b) =>
          typeof b.content === 'string' && b.content.length > maxToolResultChars
            ? { ...b, content: shrinkToolResult(b.content, maxToolResultChars) }
            : b,
        ),
      });
    }
  }
  return dropOrphanToolUses(out);
}

// A API recusa a conversa inteira (e o chat trava para sempre) se um tool_use não for seguido pelos
// tool_result correspondentes, ou se aparecer um tool_result sem o tool_use. Isso pode vir de dados
// antigos ou de um turno gravado pela metade: nesses casos fica só o texto do assistant.
function dropOrphanToolUses(messages: MessageParam[]): MessageParam[] {
  const toolUseIds = (m: MessageParam | undefined) =>
    m?.role === 'assistant' && Array.isArray(m.content)
      ? m.content.filter((b) => b.type === 'tool_use').map((b) => b.id)
      : [];
  const toolResultIds = (m: MessageParam | undefined) =>
    m?.role === 'user' && Array.isArray(m.content)
      ? m.content
          .filter((b) => b.type === 'tool_result')
          .map((b) => b.tool_use_id)
      : [];

  const out: MessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const uses = toolUseIds(message);
    if (uses.length > 0) {
      const answered = new Set(toolResultIds(messages[i + 1]));
      if (uses.every((id) => answered.has(id))) {
        out.push(message);
        continue;
      }
      const text = (message.content as ContentBlockParam[])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      out.push({ role: 'assistant', content: text || '(ação não concluída)' });
      continue;
    }

    const results = toolResultIds(message);
    if (results.length > 0) {
      const asked = new Set(toolUseIds(out.at(-1)));
      if (!results.every((id) => asked.has(id))) continue;
    }
    out.push(message);
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
