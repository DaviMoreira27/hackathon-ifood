import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import type {
  MessagesService,
  SeenFacts,
} from '../../messages/messages.service.js';
import type { AgentConfig } from '../agent.config.js';
import {
  messagesToRows,
  rowsToMessages,
  shrinkToolResults,
} from '../history.js';

// A janela de histórico anda em saltos deste tamanho (ver windowStart).
const HISTORY_STEP = 20;

export interface SavedTurn {
  // A mensagem do usuário que abriu o turno, já com o estado do pedido.
  userMessageId?: number;
  userMessage?: MessageParam;
  // O que o turno acrescentou (tool_use, tool_result e resposta).
  messages: MessageParam[];
  // Ids e valores vistos neste turno (registro do chat).
  facts?: SeenFacts;
}

// Conversa de um chat na tabela messages, já no formato da API da Anthropic.
export class ConversationStore {
  constructor(
    private readonly messages: MessagesService,
    private readonly config: AgentConfig,
  ) {}

  async addText(
    chatId: number,
    userId: number,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<number> {
    return this.messages.add({ chatId, userId, role, content });
  }

  // A janela recente; só os últimos turnos voltam com as chamadas de ferramenta.
  async recent(chatId: number): Promise<MessageParam[]> {
    return rowsToMessages(
      await this.messages.recent(chatId, this.config.historyRows, HISTORY_STEP),
      this.config.historyToolTurns,
    );
  }

  seenFacts(chatId: number): Promise<SeenFacts> {
    return this.messages.seenFacts(chatId);
  }

  // O turno inteiro (tool_use, tool_result e resposta) é gravado de uma vez, para o histórico
  // nunca ficar com uma chamada de ferramenta sem resultado. Os resultados já vão encurtados.
  async saveTurn(
    chatId: number,
    userId: number,
    turn: SavedTurn,
  ): Promise<void> {
    const { userMessageId, userMessage } = turn;
    await Promise.all([
      this.messages.addMany(
        messagesToRows(
          chatId,
          userId,
          shrinkToolResults(turn.messages, this.config.historyToolResultChars),
        ),
      ),
      userMessageId !== undefined && Array.isArray(userMessage?.content)
        ? this.messages.setPayload(userMessageId, userMessage.content)
        : undefined,
      turn.facts ? this.messages.rememberFacts(chatId, turn.facts) : undefined,
    ]);
  }

  async clear(chatId: number): Promise<void> {
    await this.messages.clearChat(chatId);
  }
}
