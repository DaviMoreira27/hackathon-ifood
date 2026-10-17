import { Inject, Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.js';
import { AuthService } from '../auth/auth.service.js';
import { McpService, McpUnauthorizedError } from '../mcp/mcp.service.js';
import { MessagesService } from '../messages/messages.service.js';
import { UsersService } from '../users/users.service.js';
import { messagesToRows, rowsToMessages } from './history.js';

export const ANTHROPIC_CLIENT = Symbol('ANTHROPIC_CLIENT');

const MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 4096;
const MAX_TOOL_ROUNDS = 10;
// Quantas linhas da tabela messages entram no contexto do LLM.
const HISTORY_ROWS = 40;

const SYSTEM_PROMPT = `Você é o assistente de pedidos em grupo do iFood.
Seu papel é:
1. Coletar o nome e as preferências de cada participante do grupo
2. Sugerir pratos/restaurantes usando getRecommendations para cada pessoa
3. Montar carrinhos (um por restaurante) com os itens escolhidos
4. Ao final, dividir a conta e gerar QR Codes de pagamento (PIX ou token iFood) para cada participante

Seja proativo: após cada confirmação de item, avance para o próximo participante.
Sempre confirme o resumo dos carrinhos antes de fechar o pedido.
Responda sempre em português brasileiro.`;

const FALLBACK_REPLY = 'Desculpe, ocorreu um erro interno. Tente novamente.';
// O link de login tem um state de uso único: o que fica no histórico é só um marcador.
const LOGIN_MARKER = '[link de login do iFood enviado]';

export interface ChatProfile {
  name?: string;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  // Serializa as mensagens de um mesmo chat para não rodar dois loops sobre o mesmo histórico.
  private readonly queues = new Map<number, Promise<unknown>>();

  constructor(
    @Inject(ANTHROPIC_CLIENT) private readonly anthropic: Anthropic,
    private readonly auth: AuthService,
    private readonly mcp: McpService,
    private readonly users: UsersService,
    private readonly messages: MessagesService,
  ) {}

  handle(chatId: number, text: string, profile?: ChatProfile): Promise<string> {
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.process(chatId, text, profile));
    this.queues.set(chatId, next);
    void next.finally(() => {
      if (this.queues.get(chatId) === next) this.queues.delete(chatId);
    });
    return next;
  }

  private async process(
    chatId: number,
    text: string,
    profile?: ChatProfile,
  ): Promise<string> {
    this.logger.log(
      `[agent] mensagem do chat ${chatId}: ${JSON.stringify(text)}`,
    );
    if (text.trim() === '/logout') {
      await this.auth.logout(chatId);
      this.mcp.drop(chatId);
      // Zera o contexto: a próxima conta não deve herdar ids de carrinho/itens da anterior.
      await this.messages.clearChat(chatId);
      return 'Você saiu da sua conta iFood.';
    }

    const user = await this.users.getOrCreateByTelegram(chatId, profile?.name);
    await this.messages.add({
      chatId,
      userId: user.id,
      role: 'user',
      content: text,
    });

    const token = await this.auth.getValidAccessToken(chatId);
    if (!token) {
      this.logger.log(`[agent] chat ${chatId} sem login — enviando link`);
      return this.loginReply(chatId, user.id);
    }

    try {
      const session = await this.mcp.getSession(chatId, token);
      // Já inclui a mensagem do usuário gravada acima.
      const messages = rowsToMessages(
        await this.messages.recent(chatId, HISTORY_ROWS),
      );
      const turnStart = messages.length;

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        this.logger.log(
          `[agent] rodada ${round + 1}: chamando LLM (${messages.length} mensagens no contexto)`,
        );
        const response = await this.anthropic.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          tools: session.tools,
          messages,
        });

        messages.push({ role: 'assistant', content: response.content });
        this.logger.log(
          `[agent] LLM respondeu stop_reason=${response.stop_reason} (tokens in=${response.usage?.input_tokens} out=${response.usage?.output_tokens})`,
        );

        if (response.stop_reason !== 'tool_use') {
          const reply =
            response.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n') || FALLBACK_REPLY;
          // O turno inteiro (tool_use, tool_result e resposta) é gravado de uma vez,
          // para o histórico nunca ficar com uma chamada de ferramenta sem resultado.
          await this.messages.addMany(
            messagesToRows(chatId, user.id, messages.slice(turnStart)),
          );
          this.logger.log(
            `[agent] resposta final para o chat ${chatId} após ${round + 1} rodada(s) (${reply.length} chars)`,
          );
          return reply;
        }

        const toolResults: ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          this.logger.log(`[agent] LLM pediu a ferramenta ${block.name}`);

          try {
            const result = await this.mcp.callTool(
              session,
              block.name,
              block.input,
            );
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.text,
              is_error: result.isError,
            });
          } catch (err) {
            if (err instanceof McpUnauthorizedError) throw err;
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Erro ao executar ${block.name}: ${String(err)}`,
              is_error: true,
            });
          }
        }

        messages.push({ role: 'user', content: toolResults });
      }

      this.logger.warn(
        `Limite de ${MAX_TOOL_ROUNDS} rodadas de ferramentas atingido para o chat ${chatId}`,
      );
      await this.messages.add({
        chatId,
        userId: user.id,
        role: 'assistant',
        content: FALLBACK_REPLY,
      });
      return FALLBACK_REPLY;
    } catch (err) {
      if (err instanceof McpUnauthorizedError) {
        this.logger.warn(
          `[agent] MCP recusou o token do chat ${chatId} (401) — pedindo login de novo`,
        );
        await this.auth.invalidate(chatId);
        this.mcp.drop(chatId);
        return this.loginReply(chatId, user.id);
      }
      throw err;
    }
  }

  private async loginReply(chatId: number, userId: number): Promise<string> {
    await this.messages.add({
      chatId,
      userId,
      role: 'assistant',
      content: LOGIN_MARKER,
    });
    return `Para continuar, entre na sua conta iFood:\n${this.auth.buildLoginUrl(chatId)}`;
  }
}
