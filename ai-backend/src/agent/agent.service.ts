import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages.js';
import { AuthService } from '../auth/auth.service.js';
import {
  McpService,
  McpUnauthorizedError,
  type McpSession,
} from '../mcp/mcp.service.js';
import {
  GroupOrderTools,
  type Preparation,
  type ToolContext,
} from '../group-order/group-order.tools.js';
import { MessagesService } from '../messages/messages.service.js';
import { UsersService } from '../users/users.service.js';
import { GroupOrderError } from '../group-order/group-order.errors.js';
import { formatBRL, toCents } from '../group-order/money.js';
import type { TraceTool } from '../db/schema.js';
import {
  DIET_TOOLS,
  DietaryTools,
  policyFor,
} from '../dietary/dietary.tools.js';
import {
  cartIdOf,
  GET_CART,
  getCartArgs,
  parseCart,
  triggersCartSync,
} from './cart-sync.js';
import { messagesToRows, rowsToMessages } from './history.js';
import { imageCatalog, takeImages, type ReplyImage } from './images.js';
import {
  comparePrices,
  isPriceTool,
  PRICE_TOOLS,
  priceFacts,
} from './price-tools.js';
import { orderStateBlock, orderSummary } from './order-state.js';
import { cachedMessages, cachedSystem, cachedTools } from './prompt-cache.js';
import {
  correctionNote,
  emptyReplyNote,
  factCorpus,
  knownCents,
  stripAmounts,
  unbackedClaims,
  unknownAmounts,
  unseenIds,
} from './reply-check.js';
import { strictTool } from './strict-tools.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { wrapToolResult } from './tool-policy.js';
import { TurnTracesService } from './turn-traces.service.js';
import { AGENT_CONFIG, type AgentConfig } from './agent.config.js';

export const ANTHROPIC_CLIENT = Symbol('ANTHROPIC_CLIENT');

// Mensagens do mesmo chat esperando na fila: acima disso, o usuário recebe "aguarde"
// em vez de enfileirar mais chamadas ao LLM (custo) e ao MCP.
const MAX_QUEUED_PER_CHAT = 3;
const CONFIRM_TTL_MS = 5 * 60 * 1000;
// O usuário confirma digitando "confirmar" (a barra é opcional). Só vale a mensagem inteira: uma
// frase como "pode confirmar" não conta, e o texto de um resultado de ferramenta nunca chega aqui.
const CONFIRM_PATTERN = /^\/?confirmar[.!\s]*$/i;
const NOTHING_PENDING_REPLY =
  'Não há nenhuma ação aguardando confirmação (ou ela expirou). Peça de novo, por favor.';

const FALLBACK_REPLY = 'Desculpe, ocorreu um erro interno. Tente novamente.';
const REFUSAL_REPLY =
  'Não posso ajudar com esse pedido. Posso ajudar a buscar comida, montar o carrinho ou dividir a conta.';
const BUSY_REPLY =
  'Ainda estou processando suas mensagens anteriores. Aguarde a resposta antes de mandar outra.';
// O link de login tem um state de uso único: o que fica no histórico é só um marcador.
const LOGIN_MARKER = '[link de login do iFood enviado]';
const BLOCKED_RESULT =
  'BLOQUEADO: esta ação exige confirmação explícita do usuário. O sistema já anexa à sua resposta o pedido de confirmação (o usuário responde "confirmar"). Não chame a ferramenta de novo, não repita a instrução de confirmação nem cite nomes de ferramentas ou ids; explique em linguagem simples o que vai acontecer e aguarde.';
const ALREADY_PENDING_RESULT =
  'BLOQUEADO: já existe outra ação aguardando confirmação do usuário neste turno. Uma ação sensível por vez.';

export interface ChatProfile {
  name?: string;
}

export interface AgentReply {
  text: string;
  // Fotos de pratos/lojas escolhidas pelo LLM e validadas pelo código (ver images.ts).
  images: ReplyImage[];
}

// Ação sensível que o LLM pediu e que só roda, com estes argumentos exatos, depois do /confirmar.
interface PendingAction {
  name: string;
  input: Record<string, unknown>;
  expiresAt: number;
  // O que o usuário vê no pedido de confirmação (montado pelo código). Sem isso, mostra os argumentos.
  summary?: string;
}

interface TurnState {
  pending?: PendingAction;
  ctx: ToolContext;
  // Textos que as ferramentas locais mandam anexar à resposta (links de pagamento): saem do
  // código, não passam pelo LLM, que poderia estragá-los.
  appendices: string[];
  // Uma ferramenta diet_* rodou: o bloco de restrições do system precisa ser relido.
  dietChanged?: boolean;
  // Nome do perfil do Telegram: o modelo usa como participante quando o dono pede para si.
  ownerName?: string;
  // Conversa viva (histórico + turno) e o estado do pedido injetado: base dos validadores.
  messages: MessageParam[];
  stateBlock: string;
  // Ferramentas que deram certo neste turno (checagem de "disse que fez").
  succeeded: string[];
  // O carrinho mudou neste turno: a resposta leva o resumo do pedido montado pelo código.
  cartChanged?: boolean;
  trace: TraceTool[];
  validatorHits: string[];
}

interface StopDetails {
  category?: string | null;
  explanation?: string | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Cópia das mensagens com o estado do pedido anexado à mensagem do usuário que abriu o turno. Só vai
// para a API: o histórico gravado não acumula estados antigos.
function withState(
  messages: MessageParam[],
  index: number,
  block: string,
): MessageParam[] {
  const target = messages[index];
  if (!block || target?.role !== 'user') return messages;
  const content =
    typeof target.content === 'string'
      ? [{ type: 'text' as const, text: target.content }]
      : target.content;
  const copy = [...messages];
  copy[index] = {
    ...target,
    content: [...content, { type: 'text', text: block }],
  };
  return copy;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  // Serializa as mensagens de um mesmo chat para não rodar dois loops sobre o mesmo histórico.
  private readonly queues = new Map<number, Promise<unknown>>();
  private readonly queueDepth = new Map<number, number>();
  // Em memória de propósito: reiniciar o back cancela confirmações pendentes (lado seguro).
  private readonly pendingActions = new Map<number, PendingAction>();

  constructor(
    @Inject(ANTHROPIC_CLIENT) private readonly anthropic: Anthropic,
    private readonly auth: AuthService,
    private readonly mcp: McpService,
    private readonly users: UsersService,
    private readonly messages: MessagesService,
    private readonly groupTools: GroupOrderTools,
    private readonly dietTools: DietaryTools,
    private readonly traces: TurnTracesService,
    @Inject(AGENT_CONFIG) private readonly config: AgentConfig,
  ) {}

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
  ): Promise<AgentReply> {
    const depth = this.queueDepth.get(chatId) ?? 0;
    if (depth >= MAX_QUEUED_PER_CHAT) {
      this.logger.warn(`[agent] chat ${chatId} com fila cheia (${depth})`);
      return Promise.resolve({ text: BUSY_REPLY, images: [] });
    }
    this.queueDepth.set(chatId, depth + 1);

    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async (): Promise<AgentReply> => {
        const images: ReplyImage[] = [];
        const reply = await this.process(chatId, text, images, profile);
        return { text: reply, images };
      });
    this.queues.set(chatId, next);
    // O .catch é obrigatório: sem ele a promise derivada do finally rejeita sem handler
    // quando process falha, e o Node derruba o processo (unhandled rejection).
    next
      .finally(() => {
        const remaining = (this.queueDepth.get(chatId) ?? 1) - 1;
        if (remaining > 0) this.queueDepth.set(chatId, remaining);
        else this.queueDepth.delete(chatId);
        if (this.queues.get(chatId) === next) this.queues.delete(chatId);
      })
      .catch(() => undefined);
    return next;
  }

  // `images` recebe as fotos da resposta final (o texto é o retorno).
  private async process(
    chatId: number,
    text: string,
    images: ReplyImage[],
    profile?: ChatProfile,
  ): Promise<string> {
    this.logger.log(
      `[agent] mensagem do chat ${chatId} (${text.length} chars)`,
    );
    const command = text.trim();
    // Qualquer mensagem consome a ação pendente: só um /confirmar logo em seguida a executa.
    const pending = this.pendingActions.get(chatId);
    this.pendingActions.delete(chatId);

    if (command === '/logout') {
      await this.auth.logout(chatId);
      this.mcp.drop(chatId);
      // Zera o contexto: a próxima conta não deve herdar ids de carrinho/itens da anterior.
      await this.messages.clearChat(chatId);
      return 'Você saiu da sua conta iFood.';
    }

    let confirmed: PendingAction | undefined;
    if (CONFIRM_PATTERN.test(command)) {
      if (pending && pending.expiresAt >= Date.now()) {
        confirmed = pending;
      } else if (pending || command.startsWith('/')) {
        return NOTHING_PENDING_REPLY;
      }
      // "confirmar" sem nada pendente e sem barra é conversa normal: segue para o LLM.
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

    // Preenchido ao entrar no loop; usado para não perder o que já foi executado se o turno falhar.
    let turn: MessageParam[] = [];
    // Resposta rejeitada pelo validador e a nota de correção: valem só dentro do turno. Gravadas,
    // voltariam nos próximos turnos e o modelo passaria a comentar as correções com o usuário.
    const scratch = new Set<MessageParam>();
    let persisted = false;
    const saveTurn = async () => {
      persisted = true;
      // O turno inteiro (tool_use, tool_result e resposta) é gravado de uma vez,
      // para o histórico nunca ficar com uma chamada de ferramenta sem resultado.
      await this.messages.addMany(
        messagesToRows(
          chatId,
          user.id,
          turn.filter((m) => !scratch.has(m)),
        ),
      );
    };

    // Fora do try: se o turno falhar depois de gerar os links, eles ainda chegam ao usuário.
    const appendices: string[] = [];
    const startedAt = new Date();
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let rounds = 0;
    let outcome = 'error';
    let traceError: string | null = null;
    const state: TurnState = {
      ctx: { chatId, userId: user.id },
      appendices,
      ownerName: profile?.name,
      messages: [],
      stateBlock: '',
      succeeded: [],
      trace: [],
      validatorHits: [],
    };

    try {
      const session = await this.mcp.getSession(chatId, token);
      // Já inclui a mensagem do usuário gravada acima.
      const messages = rowsToMessages(
        await this.messages.recent(chatId, this.config.historyRows),
        this.config.historyToolResultChars,
      );
      state.messages = messages;
      const turnStart = messages.length;
      state.stateBlock = await this.stateBlock(state);
      // Ferramentas do iFood + as do pedido em grupo; o checkout só aparece com o pedido pago.
      // As locais vão com strict: os argumentos sempre respeitam o schema.
      const tools = cachedTools([
        ...this.groupTools
          .mergeTools(
            session.tools,
            await this.groupTools.checkoutAllowed(user.id),
          )
          .map((t) => (this.groupTools.has(t.name) ? strictTool(t) : t)),
        ...PRICE_TOOLS.map(strictTool),
        ...DIET_TOOLS.map(strictTool),
      ]);
      // Política de restrição alimentar: só entra no prompt de quem declarou uma restrição.
      let dietPolicy = policyFor(await this.dietTools.list(user.id));
      const push = (message: MessageParam) => {
        messages.push(message);
        turn = messages.slice(turnStart);
      };
      let retried = false;
      const pushScratch = (message: MessageParam) => {
        scratch.add(message);
        push(message);
      };

      if (confirmed) {
        // Executa exatamente o que o usuário viu na confirmação, sem passar pelo LLM de novo.
        const block = {
          type: 'tool_use',
          id: `toolu_confirm_${randomBytes(8).toString('hex')}`,
          name: confirmed.name,
          input: confirmed.input,
        } as ToolUseBlock;
        this.logger.log(
          `[agent] chat ${chatId} confirmou ${confirmed.name} — executando`,
        );
        push({ role: 'assistant', content: [block] });
        push({
          role: 'user',
          content: await this.runTools(chatId, session, [block], state, true),
        });
      }

      for (let round = 0; round < this.config.maxToolRounds; round++) {
        rounds = round + 1;
        if (state.dietChanged) {
          dietPolicy = policyFor(await this.dietTools.list(user.id));
          state.dietChanged = false;
        }
        this.logger.log(
          `[agent] rodada ${round + 1}: chamando LLM (${messages.length} mensagens no contexto)`,
        );
        const params = {
          model: this.config.model,
          max_tokens: this.config.maxTokens,
          output_config: { effort: this.config.effort },
          system: cachedSystem(SYSTEM_PROMPT, dietPolicy),
          tools,
          messages: cachedMessages(
            withState(messages, turnStart - 1, state.stateBlock),
          ),
        };
        const response: Message = await this.anthropic.messages.create(
          params as MessageCreateParamsNonStreaming,
        );
        usage.input += response.usage?.input_tokens ?? 0;
        usage.output += response.usage?.output_tokens ?? 0;
        usage.cacheRead += response.usage?.cache_read_input_tokens ?? 0;
        usage.cacheWrite += response.usage?.cache_creation_input_tokens ?? 0;
        this.logger.log(
          `[agent] LLM respondeu stop_reason=${response.stop_reason} (tokens in=${response.usage?.input_tokens} cache_read=${response.usage?.cache_read_input_tokens ?? 0} cache_write=${response.usage?.cache_creation_input_tokens ?? 0} out=${response.usage?.output_tokens})`,
        );

        if (response.stop_reason === 'refusal') {
          // A recusa pode cortar um tool_use no meio: nada desta resposta é executado nem gravado.
          const details = (response as { stop_details?: StopDetails | null })
            .stop_details;
          this.logger.warn(
            `[agent] LLM recusou no chat ${chatId} (categoria=${details?.category ?? 'desconhecida'})`,
          );
          push({
            role: 'assistant',
            content: [{ type: 'text', text: REFUSAL_REPLY }],
          });
          await saveTurn();
          outcome = 'refusal';
          return this.withConfirmation(
            chatId,
            [REFUSAL_REPLY, ...appendices].join('\n\n'),
            state,
          );
        }

        if (response.stop_reason !== 'tool_use') {
          // Com max_tokens o modelo pode parar no meio de um tool_use. Ele não é executado, então
          // não pode ir para o histórico: um tool_use sem tool_result quebra todas as próximas chamadas.
          const content = response.content.filter((b) => b.type !== 'tool_use');
          let text = content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n');

          // O modelo às vezes encerra o turno só com raciocínio, sem texto: pede a resposta uma vez
          // em vez de mandar o erro genérico ao usuário. Com links ou confirmação pendente, o código
          // já tem o que mostrar.
          if (
            !text.trim() &&
            !appendices.length &&
            !state.pending &&
            !retried &&
            round + 1 < this.config.maxToolRounds
          ) {
            retried = true;
            state.validatorHits.push(`vazia:${response.stop_reason}`);
            this.logger.warn(
              `[agent] resposta sem texto no chat ${chatId} (stop_reason=${response.stop_reason}); pedindo de novo`,
            );
            if (content.length) pushScratch({ role: 'assistant', content });
            pushScratch({
              role: 'user',
              content: [{ type: 'text', text: emptyReplyNote() }],
            });
            continue;
          }

          // Validador da resposta final: todo R$ precisa ter vindo de uma ferramenta, do sistema
          // ou do usuário, e toda ação afirmada precisa ter dado certo neste turno.
          const amounts = unknownAmounts(
            text,
            knownCents(factCorpus(messages, [state.stateBlock, ...appendices])),
          );
          const claims = unbackedClaims(text, state.succeeded);
          if (amounts.length || claims.length) {
            const hits = [
              ...amounts.map((a) => `valor:${a.text}`),
              ...claims.map((c) => `acao:${c}`),
            ];
            state.validatorHits.push(...hits);
            this.logger.warn(
              `[agent] validador da resposta disparou no chat ${chatId}${retried ? ' (de novo)' : ''}: ${hits.join(', ')}`,
            );
            if (!retried && round + 1 < this.config.maxToolRounds) {
              retried = true;
              pushScratch({ role: 'assistant', content });
              pushScratch({
                role: 'user',
                content: [
                  { type: 'text', text: correctionNote(amounts, claims) },
                ],
              });
              continue;
            }
            // Persistiu: o valor sem origem sai da resposta.
            text = stripAmounts(text, amounts);
          }

          push({ role: 'assistant', content });
          // As fotos saem do texto e vão como imagens; só valem URLs que vieram das ferramentas.
          const { text: cleaned, images: chosen } = takeImages(
            text,
            imageCatalog(messages),
          );
          images.push(...chosen);
          const summary = state.cartChanged
            ? await this.orderSummary(state, cleaned)
            : null;
          const reply = [
            cleaned || (appendices.length || summary ? '' : FALLBACK_REPLY),
            summary,
            ...appendices,
          ]
            .filter(Boolean)
            .join('\n\n');
          await saveTurn();
          outcome = 'reply';
          this.logger.log(
            `[agent] resposta final para o chat ${chatId} após ${round + 1} rodada(s) (${reply.length} chars)`,
          );
          return this.withConfirmation(chatId, reply, state);
        }

        push({ role: 'assistant', content: response.content });
        push({
          role: 'user',
          content: await this.runTools(
            chatId,
            session,
            response.content,
            state,
          ),
        });
      }

      this.logger.warn(
        `Limite de ${this.config.maxToolRounds} rodadas de ferramentas atingido para o chat ${chatId}`,
      );
      push({
        role: 'assistant',
        content: [{ type: 'text', text: FALLBACK_REPLY }],
      });
      await saveTurn();
      outcome = 'tool_limit';
      return this.withConfirmation(
        chatId,
        [FALLBACK_REPLY, ...appendices].join('\n\n'),
        state,
      );
    } catch (err) {
      traceError = String(err);
      // Ferramentas já executadas (itens no carrinho, pedido fechado) precisam ficar no histórico,
      // senão o LLM não sabe delas na próxima mensagem e repete a ação.
      if (!persisted && turn.length > 0) {
        await saveTurn().catch((saveErr) =>
          this.logger.error(
            `[agent] falha ao gravar turno parcial do chat ${chatId}: ${String(saveErr)}`,
          ),
        );
      }
      if (err instanceof McpUnauthorizedError) {
        this.logger.warn(
          `[agent] MCP recusou o token do chat ${chatId} (401) — pedindo login de novo`,
        );
        await this.auth.invalidate(chatId);
        this.mcp.drop(chatId);
        return this.loginReply(chatId, user.id);
      }
      if (appendices.length > 0) {
        // O pedido já foi confirmado e os links existem: entrega-os em vez de só dar erro.
        this.logger.error(
          `[agent] turno do chat ${chatId} falhou depois de gerar links: ${String(err)}`,
        );
        return [FALLBACK_REPLY, ...appendices].join('\n\n');
      }
      throw err;
    } finally {
      void this.traces.record({
        chatId,
        userId: user.id,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        rounds,
        outcome,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        tools: state.trace,
        validatorHits: state.validatorHits,
        error: traceError,
      });
    }
  }

  // Estado do pedido lido do banco no começo do turno. Sem conseguir ler, o turno segue sem ele.
  private async stateBlock(state: TurnState): Promise<string> {
    try {
      return orderStateBlock(
        await this.groupTools.orderView(state.ctx),
        state.ownerName,
      );
    } catch (err) {
      this.logger.warn(
        `[agent] não consegui ler o estado do pedido do chat ${state.ctx.chatId}: ${String(err)}`,
      );
      return '';
    }
  }

  private async orderSummary(
    state: TurnState,
    reply: string,
  ): Promise<string | null> {
    try {
      return orderSummary(await this.groupTools.orderView(state.ctx), reply);
    } catch (err) {
      this.logger.warn(
        `[agent] não consegui montar o resumo do pedido do chat ${state.ctx.chatId}: ${String(err)}`,
      );
      return null;
    }
  }

  // Sync automático (ver cart-sync.ts). Devolve a nota que o LLM lê junto com o resultado da
  // alteração; em qualquer falha, a nota manda usar group_sync_cart (caminho manual).
  private async syncCart(
    session: McpSession,
    state: TurnState,
    name: string,
    input: unknown,
    output: string,
  ): Promise<string> {
    const fallback = (reason: string) => {
      this.logger.warn(
        `[agent] sync automático do carrinho falhou após ${name}: ${reason}`,
      );
      state.validatorHits.push(`sync:${reason}`);
      return `Sistema: não consegui sincronizar este carrinho com o pedido em grupo automaticamente (${reason}). Leia o carrinho com getCart e registre com group_sync_cart.`;
    };
    const cartId = cartIdOf(input, output);
    if (!cartId) return fallback('cartId não identificado');
    const args = getCartArgs(session.tools, cartId);
    if (!args) return fallback(`${GET_CART} indisponível`);
    let cart: { text: string; isError: boolean };
    try {
      cart = await this.mcp.callTool(session, GET_CART, args);
    } catch (err) {
      return fallback(`${GET_CART} falhou: ${String(err).slice(0, 120)}`);
    }
    if (cart.isError) return fallback(`${GET_CART} devolveu erro`);
    const parsed = parseCart(cart.text, cartId);
    if (!parsed.ok) return fallback(parsed.reason);
    try {
      const result = await this.groupTools.syncIfoodCart(
        state.ctx,
        parsed.input,
      );
      state.cartChanged = true;
      const { subtotal, total, items } = parsed.input;
      return [
        `Sistema: carrinho sincronizado automaticamente com o pedido em grupo a partir do getCart (${items.length} item(ns), subtotal ${formatBRL(toCents(subtotal))}, total ${formatBRL(toCents(total))}). Não chame group_sync_cart.`,
        wrapToolResult('sincronizacao_do_carrinho', JSON.stringify(result)),
      ].join('\n');
    } catch (err) {
      if (err instanceof GroupOrderError) {
        this.logger.warn(
          `[agent] pedido em grupo recusou o sync do carrinho ${cartId}: ${err.message}`,
        );
        return `Sistema: o carrinho mudou no iFood, mas o pedido em grupo não aceitou a atualização: ${err.message}`;
      }
      return fallback('erro interno ao registrar');
    }
  }

  // Executa os tool_use de uma resposta. Nunca lança no meio: cada tool_use recebe um tool_result
  // (inclusive os que não rodaram), e um 401 só é relançado depois, com o lote completo em mãos.
  private async runTools(
    chatId: number,
    session: McpSession,
    content: ContentBlock[],
    state: TurnState,
    preApproved = false,
  ): Promise<ToolResultBlockParam[]> {
    const uses = content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    );
    // Várias leituras pedidas juntas (ex.: o mesmo prato em três lojas) rodam em paralelo, cada
    // uma pelo caminho normal. Escritas ficam em série (mesmo carrinho, ordem importa).
    if (
      uses.length > 1 &&
      uses.every((b) => session.readOnlyTools?.has(b.name))
    ) {
      const settled = await Promise.allSettled(
        uses.map((b) =>
          this.runTools(chatId, session, [b], state, preApproved),
        ),
      );
      let unauthorizedBatch: unknown;
      const batch = settled.map((r, i): ToolResultBlockParam => {
        if (r.status === 'fulfilled') return r.value[0];
        unauthorizedBatch ??= r.reason;
        return {
          type: 'tool_result',
          tool_use_id: uses[i].id,
          content: 'Não executada: sessão do iFood expirou.',
          is_error: true,
        };
      });
      if (unauthorizedBatch) throw unauthorizedBatch;
      return batch;
    }

    const results: ToolResultBlockParam[] = [];
    let unauthorized: McpUnauthorizedError | undefined;

    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const result = (
        text: string,
        isError: boolean,
      ): ToolResultBlockParam => ({
        type: 'tool_result',
        tool_use_id: block.id,
        content: text,
        is_error: isError,
      });
      const startedAt = Date.now();
      // Todo resultado passa por aqui: entra no trace e, se deu certo, na lista do turno.
      const emit = (r: ToolResultBlockParam) => {
        results.push(r);
        const ok = r.is_error !== true;
        state.trace.push({ name: block.name, ok, ms: Date.now() - startedAt });
        if (ok) state.succeeded.push(block.name);
      };

      if (unauthorized) {
        emit(result('Não executada: sessão do iFood expirou.', true));
        continue;
      }
      this.logger.log(`[agent] LLM pediu a ferramenta ${block.name}`);

      if (isPriceTool(block.name)) {
        try {
          emit(
            result(
              wrapToolResult(
                block.name,
                comparePrices(block.input, priceFacts(state.messages)),
              ),
              false,
            ),
          );
        } catch (err) {
          emit(
            result(
              err instanceof GroupOrderError
                ? err.message
                : `Erro interno ao executar ${block.name}.`,
              true,
            ),
          );
        }
        continue;
      }

      if (this.dietTools.has(block.name)) {
        try {
          const local = await this.dietTools.execute(
            block.name,
            block.input,
            state.ctx,
          );
          state.dietChanged = true;
          if (local.appendix && !state.appendices.includes(local.appendix)) {
            state.appendices.push(local.appendix);
          }
          emit(result(wrapToolResult(block.name, local.text), local.isError));
        } catch (err) {
          this.logger.error(
            `[agent] falha inesperada em ${block.name}: ${String(err)}`,
          );
          emit(
            result(
              `Erro interno ao executar ${block.name}. Tente novamente.`,
              true,
            ),
          );
        }
        continue;
      }

      const isLocal = this.groupTools.has(block.name);
      if (!isLocal && !session.tools.some((t) => t.name === block.name)) {
        emit(result(`Ferramenta inexistente: ${block.name}`, true));
        continue;
      }
      const input = isPlainObject(block.input) ? block.input : {};

      if (isLocal) {
        // Ferramentas do pedido em grupo. As que cobram pessoas passam pelo mesmo gate de
        // confirmação das ferramentas sensíveis do iFood. Erro inesperado (ex.: banco) vira
        // tool_result: o lote nunca fica incompleto.
        try {
          if (!preApproved) {
            const preparation = await this.groupTools.prepare(
              state.ctx,
              block.name,
            );
            if (preparation.kind === 'reject') {
              emit(result(wrapToolResult(block.name, preparation.error), true));
              continue;
            }
            if (preparation.kind === 'confirm') {
              if (state.pending) {
                emit(result(ALREADY_PENDING_RESULT, true));
                continue;
              }
              state.pending = {
                name: block.name,
                input,
                expiresAt: Date.now() + CONFIRM_TTL_MS,
                summary: preparation.summary,
              };
              this.logger.log(
                `[agent] ${block.name} aguardando /confirmar do chat ${chatId}`,
              );
              emit(result(BLOCKED_RESULT, true));
              continue;
            }
          }
          const local = await this.groupTools.execute(
            block.name,
            input,
            state.ctx,
          );
          if (local.appendix) state.appendices.push(local.appendix);
          if (
            !local.isError &&
            (block.name === 'group_sync_cart' ||
              block.name === 'group_assign_payer')
          ) {
            state.cartChanged = true;
          }
          // Carrega nomes de itens/participantes vindos do catálogo ou do usuário: é dado, não ordem.
          emit(result(wrapToolResult(block.name, local.text), local.isError));
        } catch (err) {
          this.logger.error(
            `[agent] falha inesperada em ${block.name}: ${String(err)}`,
          );
          emit(
            result(
              `Erro interno ao executar ${block.name}. Tente novamente.`,
              true,
            ),
          );
        }
        continue;
      }

      // Registro de ids vistos: escrita com id que nunca apareceu num resultado de ferramenta (ou no
      // estado do pedido) é recusada antes do MCP. Pega id inventado e id de outra conversa.
      if (!preApproved && !session.readOnlyTools?.has(block.name)) {
        const unseen = unseenIds(
          input,
          factCorpus(state.messages, [state.stateBlock]),
        );
        if (unseen.length > 0) {
          const list = unseen.map((u) => `${u.key}=${u.value}`).join(', ');
          this.logger.warn(
            `[agent] chamada a ${block.name} barrada: ids nunca vistos (${list})`,
          );
          state.validatorHits.push(`id:${block.name}:${list}`);
          emit(
            result(
              `Recusado pelo sistema: ${list} não apareceu em nenhum resultado de ferramenta desta conversa. Consulte antes (ex.: getCart, getMerchant, listAddresses) e use o id exato que a ferramenta devolveu.`,
              true,
            ),
          );
          continue;
        }
      }

      // Trava do checkout: só com o pedido pago, e nunca de um carrinho ainda não pago.
      let forbidden: string | null;
      try {
        forbidden = await this.groupTools.checkMcpCall(
          state.ctx,
          block.name,
          input,
        );
      } catch (err) {
        // Sem conseguir checar o pagamento, o checkout não roda (lado seguro).
        this.logger.error(
          `[agent] falha ao checar ${block.name}: ${String(err)}`,
        );
        forbidden = `Não consegui verificar o estado dos pagamentos agora; ${block.name} não foi executada. Tente novamente.`;
      }
      if (forbidden) {
        this.logger.warn(
          `[agent] chamada a ${block.name} barrada: ${forbidden}`,
        );
        emit(result(forbidden, true));
        continue;
      }

      // Trava da restrição alimentar: item não verificado é recusado, item cortado pede /confirmar.
      if (!preApproved) {
        let diet: Preparation;
        try {
          diet = await this.dietTools.prepareMcpCall(
            state.ctx,
            block.name,
            input,
          );
        } catch (err) {
          // Sem conseguir checar as restrições, o item não entra (lado seguro).
          this.logger.error(
            `[agent] falha ao checar restrição alimentar em ${block.name}: ${String(err)}`,
          );
          diet = {
            kind: 'reject',
            error: `Não consegui verificar as restrições alimentares agora; ${block.name} não foi executada. Tente novamente.`,
          };
        }
        if (diet.kind === 'reject') {
          this.logger.warn(
            `[agent] chamada a ${block.name} barrada pela restrição alimentar`,
          );
          emit(result(diet.error, true));
          continue;
        }
        if (diet.kind === 'confirm') {
          if (state.pending) {
            emit(result(ALREADY_PENDING_RESULT, true));
            continue;
          }
          state.pending = {
            name: block.name,
            input,
            expiresAt: Date.now() + CONFIRM_TTL_MS,
            summary: diet.summary,
          };
          this.logger.log(
            `[agent] ${block.name} (item cortado pelo filtro alimentar) aguardando /confirmar do chat ${chatId}`,
          );
          emit(result(BLOCKED_RESULT, true));
          continue;
        }
      }

      if (session.confirmTools.has(block.name) && !preApproved) {
        if (state.pending) {
          emit(result(ALREADY_PENDING_RESULT, true));
          continue;
        }
        state.pending = {
          name: block.name,
          input,
          expiresAt: Date.now() + CONFIRM_TTL_MS,
        };
        this.logger.log(
          `[agent] ${block.name} aguardando /confirmar do chat ${chatId}`,
        );
        emit(result(BLOCKED_RESULT, true));
        continue;
      }

      try {
        const output = await this.mcp.callTool(session, block.name, input);
        let text = wrapToolResult(block.name, output.text);
        if (!output.isError && triggersCartSync(block.name)) {
          text += `\n${await this.syncCart(session, state, block.name, input, output.text)}`;
        }
        emit(result(text, output.isError));
      } catch (err) {
        if (err instanceof McpUnauthorizedError) {
          unauthorized = err;
          emit(result('Não executada: sessão do iFood expirou.', true));
          continue;
        }
        // Timeout/queda de conexão não diz se o servidor aplicou a ação: avisa o LLM para não
        // repetir às cegas (item duplicado, pedido fechado duas vezes). O erro cru fica só no log.
        emit(
          result(
            `Falha de comunicação ao executar ${block.name}. O resultado é DESCONHECIDO: a ação pode ter sido aplicada. Não repita; consulte o estado antes.`,
            true,
          ),
        );
      }
    }

    if (unauthorized) throw unauthorized;
    return results;
  }

  // O aviso de confirmação é montado pelo código a partir dos argumentos reais: o LLM não
  // consegue esconder ou maquiar o que vai ser executado.
  private withConfirmation(
    chatId: number,
    reply: string,
    state: TurnState,
  ): string {
    if (!state.pending) return reply;
    this.pendingActions.set(chatId, state.pending);
    return [
      reply,
      '',
      // Nome da ferramenta e argumentos ficam só nos logs: quem lê é uma pessoa.
      state.pending.summary
        ? '⚠️ **Confirmação necessária:**'
        : '⚠️ **Confirmação necessária**',
      ...(state.pending.summary ? [state.pending.summary] : []),
      '',
      'Responda **confirmar** em até 5 minutos para seguir. Qualquer outra mensagem cancela.',
    ].join('\n');
  }

  private async loginReply(chatId: number, userId: number): Promise<string> {
    await this.messages.add({
      chatId,
      userId,
      role: 'assistant',
      content: LOGIN_MARKER,
    });
    return `Para continuar, entre na sua conta iFood:\n${await this.auth.buildLoginUrl(chatId)}`;
  }
}
