import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import type { MessagesService } from '../../messages/messages.service.js';
import type { AgentConfig } from '../agent.config.js';
import { messagesToRows, rowsToMessages } from '../history.js';

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
  ): Promise<void> {
    await this.messages.add({ chatId, userId, role, content });
  }

  // A janela recente, com resultados de ferramentas antigos encurtados.
  async recent(chatId: number): Promise<MessageParam[]> {
    return rowsToMessages(
      await this.messages.recent(chatId, this.config.historyRows),
      this.config.historyToolResultChars,
    );
  }

  // O turno inteiro (tool_use, tool_result e resposta) é gravado de uma vez, para o histórico
  // nunca ficar com uma chamada de ferramenta sem resultado.
  async saveTurn(
    chatId: number,
    userId: number,
    turn: MessageParam[],
  ): Promise<void> {
    await this.messages.addMany(messagesToRows(chatId, userId, turn));
  }

  async clear(chatId: number): Promise<void> {
    await this.messages.clearChat(chatId);
  }
}
