import type {
  ContentBlockParam,
  MessageParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages.js';
import type { Message, NewMessage } from '../messages/messages.service.js';
import { shrinkToolResult } from './tool-envelope.js';

// Reconstrói a conversa do LLM a partir das linhas da tabela messages:
//   user      → texto do usuário, ou blocos (texto + estado do pedido) quando há payload
//   assistant → texto final, ou blocos (com tool_use) quando há payload
//   tool      → blocos tool_result (payload), que a API espera como mensagem de user
// keepToolTurns: só os últimos N turnos (cada um começa numa mensagem do usuário) voltam com
// tool_use e tool_result; dos anteriores fica o texto do assistant. Os ids e valores daqueles
// resultados continuam valendo pelo registro do chat (ver FactCorpus) e o estado do pedido de cada
// mensagem carrega carrinhos, itens e ids.
export function rowsToMessages(
  rows: Message[],
  keepToolTurns = Infinity,
): MessageParam[] {
  const out: MessageParam[] = [];
  const userRows = rows.filter((r) => r.role === 'user');
  const firstToolTurn =
    keepToolTurns >= userRows.length
      ? -Infinity
      : userRows[userRows.length - keepToolTurns].id;
  let started = false;

  for (const row of rows) {
    if (!started) {
      // A janela de histórico pode cortar um turno no meio; só começamos num texto do usuário
      // para não deixar tool_result sem o tool_use correspondente.
      if (row.role !== 'user') continue;
      started = true;
    }
    const oldTurn = row.id < firstToolTurn;

    if (row.role === 'user') {
      const blocks = row.payload as ContentBlockParam[] | null;
      out.push({ role: 'user', content: blocks?.length ? blocks : row.content });
    } else if (row.role === 'assistant') {
      // Blocos de raciocínio (thinking) de turnos anteriores não voltam ao modelo. A assinatura de
      // cada bloco amarra a conversa exata em que ele nasceu, e o histórico remontado do banco
      // muda entre mensagens (a janela anda, resultados antigos saem): reenviá-los dá 400 em
      // contas com a checagem ativa. Dentro do turno atual o array só cresce, então os blocos
      // novos continuam válidos.
      const blocks = (row.payload as ContentBlockParam[] | null)?.filter(
        (b) => b.type !== 'thinking' && b.type !== 'redacted_thinking',
      );
      if (oldTurn && blocks?.length) {
        const text = blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        if (text) pushAssistantText(out, text);
        continue;
      }
      if (!blocks?.length && oldTurn) {
        pushAssistantText(out, row.content);
        continue;
      }
      out.push({
        role: 'assistant',
        content: blocks?.length ? blocks : row.content,
      });
    } else if (row.payload != null && !oldTurn) {
      out.push({
        role: 'user',
        content: row.payload as ToolResultBlockParam[],
      });
    }
  }
  return dropOrphanToolUses(out);
}

// Num turno antigo, o texto antes das ferramentas e a resposta final viram uma mensagem só.
function pushAssistantText(out: MessageParam[], text: string): void {
  const last = out.at(-1);
  if (last?.role === 'assistant' && typeof last.content === 'string') {
    last.content = `${last.content}\n\n${text}`;
    return;
  }
  out.push({ role: 'assistant', content: text });
}

// Resultados de ferramentas são encurtados ao gravar (não ao remontar): todo turno seguinte
// recebe exatamente o mesmo conteúdo, e o prefixo do prompt cache se mantém.
export function shrinkToolResults(
  turn: MessageParam[],
  maxChars: number,
): MessageParam[] {
  return turn.map((message) => {
    if (message.role !== 'user' || typeof message.content === 'string') {
      return message;
    }
    return {
      ...message,
      content: message.content.map((b) =>
        b.type === 'tool_result' &&
        typeof b.content === 'string' &&
        b.content.length > maxChars
          ? { ...b, content: shrinkToolResult(b.content, maxChars) }
          : b,
      ),
    };
  });
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
