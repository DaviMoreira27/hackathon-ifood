import { Inject, Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { AuthService } from '../auth/auth.service.js';
import { McpService, McpUnauthorizedError } from '../mcp/mcp.service.js';
import { GroupOrderTools } from '../group-order/group-order.tools.js';
import { MessagesService } from '../messages/messages.service.js';
import { UsersService } from '../users/users.service.js';
import { DietaryTools } from '../dietary/dietary.tools.js';
import { ChatQueue } from './chat-queue.js';
import { ConversationStore } from './history/conversation.store.js';
import type { ReplyImage } from './images.js';
import type { PendingAction } from './turn/turn-context.js';
import { TurnRunner } from './turn/turn-runner.js';
import { TurnTracesService } from './turn-traces.service.js';
import { AGENT_CONFIG, type AgentConfig } from './agent.config.js';

export const ANTHROPIC_CLIENT = Symbol('ANTHROPIC_CLIENT');

const MAX_QUEUED_PER_CHAT = 3;
// O usuário confirma digitando "confirmar" (a barra é opcional). Só vale a mensagem inteira: uma
// frase como "pode confirmar" não conta, e o texto de um resultado de ferramenta nunca chega aqui.
const CONFIRM_PATTERN = /^\/?confirmar[.!\s]*$/i;
const NOTHING_PENDING_REPLY =
  'A confirmação expirou (o prazo é de 5 minutos). Peça de novo, por favor.';
const BUSY_REPLY =
  'Ainda estou processando suas mensagens anteriores. Aguarde a resposta antes de mandar outra.';
// O link de login tem um state de uso único: o que fica no histórico é só um marcador.
const LOGIN_MARKER = '[link de login do iFood enviado]';

export interface ChatProfile {
  name?: string;
}

export interface TurnOptions {
  // Etapa atual do turno ("Buscando ofertas..."), para o canal mostrar enquanto espera.
  onProgress?: (label: string) => void;
}

export interface AgentReply {
  text: string;
  // Fotos de pratos/lojas escolhidas pelo LLM e validadas pelo código (ver images.ts).
  images: ReplyImage[];
  // Uma ação sensível ficou esperando o "confirmar" (o canal mostra os botões).
  awaitingConfirmation?: boolean;
}

// Fachada do agente: fila por chat, comandos (/logout, /confirmar), login e delegação do turno
// para o TurnRunner.
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly queue = new ChatQueue(MAX_QUEUED_PER_CHAT);
  // Em memória de propósito: reiniciar o back cancela confirmações pendentes (lado seguro).
  private readonly pendingActions = new Map<number, PendingAction>();
  private readonly store: ConversationStore;
  private readonly runner: TurnRunner;

  constructor(
    @Inject(ANTHROPIC_CLIENT) anthropic: Anthropic,
    private readonly auth: AuthService,
    private readonly mcp: McpService,
    private readonly users: UsersService,
    messages: MessagesService,
    groupTools: GroupOrderTools,
    dietTools: DietaryTools,
    traces: TurnTracesService,
    @Inject(AGENT_CONFIG) config: AgentConfig,
  ) {
    this.store = new ConversationStore(messages, config);
    this.runner = new TurnRunner({
      anthropic,
      mcp,
      store: this.store,
      groupTools,
      dietTools,
      traces,
      config,
    });
  }

  // Só o texto (sem as fotos).
  async handle(
    chatId: number,
    text: string,
    profile?: ChatProfile,
  ): Promise<string> {
    return (await this.handleRich(chatId, text, profile)).text;
  }

  handleRich(
    chatId: number,
    text: string,
    profile?: ChatProfile,
    options: TurnOptions = {},
  ): Promise<AgentReply> {
    const queued = this.queue.enqueue(chatId, async () => {
      const reply = await this.process(chatId, text, profile, options);
      // Dentro da fila do chat: nenhuma outra mensagem dele consumiu a ação pendente ainda.
      return {
        ...reply,
        awaitingConfirmation: this.pendingActions.has(chatId),
      };
    });
    if (queued) return queued;
    this.logger.warn(
      `[agent] chat ${chatId} com fila cheia (${this.queue.depth(chatId)})`,
    );
    return Promise.resolve({ text: BUSY_REPLY, images: [] });
  }

  private async process(
    chatId: number,
    text: string,
    profile: ChatProfile | undefined,
    options: TurnOptions,
  ): Promise<AgentReply> {
    this.logger.log(
      `[agent] mensagem do chat ${chatId} (${text.length} chars)`,
    );
    const reply = (t: string): AgentReply => ({ text: t, images: [] });
    const command = text.trim();
    // Qualquer mensagem consome a ação pendente: só um /confirmar logo em seguida a executa.
    const pending = this.pendingActions.get(chatId);
    this.pendingActions.delete(chatId);

    if (command === '/logout') {
      await this.auth.logout(chatId);
      this.mcp.drop(chatId);
      // Zera o contexto: a próxima conta não deve herdar ids de carrinho/itens da anterior.
      await this.store.clear(chatId);
      return reply('Você saiu da sua conta iFood.');
    }

    let confirmed: PendingAction | undefined;
    if (CONFIRM_PATTERN.test(command)) {
      if (pending && pending.expiresAt >= Date.now()) {
        confirmed = pending;
      } else if (pending) {
        return reply(NOTHING_PENDING_REPLY);
      }
      // Sem nada pendente, "confirmar" vai ao LLM: se ele só tinha perguntado ("posso enviar?"),
      // agora chama a ferramenta e o sistema pede a confirmação de verdade (com os botões).
    }

    const user = await this.users.getOrCreateByChat(chatId, profile?.name);
    const [, token] = await Promise.all([
      this.store.addText(chatId, user.id, 'user', text),
      this.auth.getValidAccessToken(chatId, user),
    ]);
    if (!token) {
      this.logger.log(`[agent] chat ${chatId} sem login — enviando link`);
      return reply(await this.loginReply(chatId, user.id));
    }

    try {
      const result = await this.runner.run({
        chatId,
        userId: user.id,
        ownerName: profile?.name,
        token,
        confirmed,
        onProgress: options.onProgress,
      });
      if (result.pending) this.pendingActions.set(chatId, result.pending);
      return { text: result.text, images: result.images };
    } catch (err) {
      if (!(err instanceof McpUnauthorizedError)) throw err;
      this.logger.warn(
        `[agent] MCP recusou o token do chat ${chatId} (401) — pedindo login de novo`,
      );
      await this.auth.invalidate(chatId);
      this.mcp.drop(chatId);
      return reply(await this.loginReply(chatId, user.id));
    }
  }

  private async loginReply(chatId: number, userId: number): Promise<string> {
    await this.store.addText(chatId, userId, 'assistant', LOGIN_MARKER);
    return `Para continuar, entre na sua conta iFood:\n${await this.auth.buildLoginUrl(chatId)}`;
  }
}
