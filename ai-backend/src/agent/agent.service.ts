import { Inject, Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages.js';
import { AuthService } from '../auth/auth.service.js';
import { McpService, McpUnauthorizedError } from '../mcp/mcp.service.js';

export const ANTHROPIC_CLIENT = Symbol('ANTHROPIC_CLIENT');

const MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 4096;
const MAX_TOOL_ROUNDS = 10;
const MAX_HISTORY = 40;

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

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly history = new Map<string, MessageParam[]>();
  // Serializa as mensagens de um mesmo usuário para não rodar dois loops sobre o mesmo histórico.
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(ANTHROPIC_CLIENT) private readonly anthropic: Anthropic,
    private readonly auth: AuthService,
    private readonly mcp: McpService,
  ) {}

  handle(userId: string, text: string): Promise<string> {
    const previous = this.queues.get(userId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.process(userId, text));
    this.queues.set(userId, next);
    void next.finally(() => {
      if (this.queues.get(userId) === next) this.queues.delete(userId);
    });
    return next;
  }

  private async process(userId: string, text: string): Promise<string> {
    this.logger.log(`[agent] mensagem de ${userId}: ${JSON.stringify(text)}`);
    if (text.trim() === '/logout') {
      await this.auth.logout(userId);
      this.mcp.drop(userId);
      this.history.delete(userId);
      return 'Você saiu da sua conta iFood.';
    }

    const token = await this.auth.getValidAccessToken(userId);
    if (!token) {
      this.logger.log(`[agent] ${userId} sem login — enviando link`);
      return this.loginReply(userId);
    }

    try {
      const session = await this.mcp.getSession(userId, token);
      const messages: MessageParam[] = [
        ...(this.history.get(userId) ?? []),
        { role: 'user', content: text },
      ];

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
          this.history.set(userId, trimHistory(messages));
          const reply =
            response.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n') || FALLBACK_REPLY;
          this.logger.log(
            `[agent] resposta final para ${userId} após ${round + 1} rodada(s) (${reply.length} chars)`,
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
        `Limite de ${MAX_TOOL_ROUNDS} rodadas de ferramentas atingido para ${userId}`,
      );
      return FALLBACK_REPLY;
    } catch (err) {
      if (err instanceof McpUnauthorizedError) {
        this.logger.warn(
          `[agent] MCP recusou o token de ${userId} (401) — pedindo login de novo`,
        );
        this.auth.invalidate(userId);
        this.mcp.drop(userId);
        return this.loginReply(userId);
      }
      throw err;
    }
  }

  private loginReply(userId: string): string {
    return `Para continuar, entre na sua conta iFood:\n${this.auth.buildLoginUrl(userId)}`;
  }
}

// Mantém as últimas mensagens, começando sempre numa mensagem de texto do usuário
// para não deixar tool_result sem o tool_use correspondente.
export function trimHistory(messages: MessageParam[]): MessageParam[] {
  if (messages.length <= MAX_HISTORY) return messages;
  let start = messages.length - MAX_HISTORY;
  while (
    start < messages.length &&
    !(
      messages[start].role === 'user' &&
      typeof messages[start].content === 'string'
    )
  ) {
    start++;
  }
  return messages.slice(start);
}
