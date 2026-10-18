import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages.js';
import { policyFor, type DietaryTools } from '../../dietary/dietary.tools.js';
import type { GroupOrderTools } from '../../group-order/group-order.tools.js';
import {
  McpUnauthorizedError,
  type McpService,
} from '../../mcp/mcp.service.js';
import type { AgentConfig } from '../agent.config.js';
import type { ConversationStore } from '../history/conversation.store.js';
import type { ReplyImage } from '../images.js';
import { orderStateBlock } from '../order-state.js';
import { cachedMessages, cachedSystem, cachedTools } from '../prompt-cache.js';
import { SYSTEM_PROMPT } from '../system-prompt.js';
import type { TurnTracesService } from '../turn-traces.service.js';
import { CheckoutGate } from '../tools/gates/checkout.gate.js';
import { ConfirmGate } from '../tools/gates/confirm.gate.js';
import { DietGate } from '../tools/gates/diet.gate.js';
import { GroupConfirmGate } from '../tools/gates/group-confirm.gate.js';
import { UnseenIdsGate } from '../tools/gates/unseen-ids.gate.js';
import { CartSyncHook } from '../tools/hooks/cart-sync.hook.js';
import { DietSource } from '../tools/sources/diet.source.js';
import { GroupSource } from '../tools/sources/group.source.js';
import { McpSource } from '../tools/sources/mcp.source.js';
import { PriceSource } from '../tools/sources/price.source.js';
import { ToolExecutor } from '../tools/tool-executor.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import {
  FALLBACK_REPLY,
  REFUSAL_REPLY,
  ReplyFinalizer,
} from './reply-finalizer.js';
import { TurnContext, type PendingAction } from './turn-context.js';
import { TurnTranscript } from './turn-transcript.js';

export interface TurnInput {
  chatId: number;
  userId: number;
  ownerName?: string;
  token: string;
  // Ação aprovada pelo /confirmar: roda antes do LLM, exatamente como o usuário viu.
  confirmed?: PendingAction;
}

export interface TurnResult {
  text: string;
  images: ReplyImage[];
  // Ação sensível que ficou esperando o /confirmar do usuário.
  pending?: PendingAction;
}

export interface TurnDeps {
  anthropic: Anthropic;
  mcp: McpService;
  store: ConversationStore;
  groupTools: GroupOrderTools;
  dietTools: DietaryTools;
  traces: TurnTracesService;
  config: AgentConfig;
}

interface StopDetails {
  category?: string | null;
  explanation?: string | null;
}

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

// O loop do LLM de um turno: monta a requisição, executa as ferramentas pedidas e para na resposta
// final, na recusa ou no limite de rodadas. Grava o turno e o trace.
export class TurnRunner {
  private readonly logger = new Logger('AgentService');
  private readonly registry: ToolRegistry;
  private readonly executor: ToolExecutor;
  private readonly finalizer: ReplyFinalizer;

  constructor(private readonly deps: TurnDeps) {
    const { mcp, groupTools, dietTools } = deps;
    this.registry = new ToolRegistry(
      [
        new PriceSource(),
        new DietSource(dietTools, this.logger),
        new GroupSource(groupTools, this.logger),
        new McpSource(mcp),
      ],
      groupTools,
    );
    // Mesma ordem de sempre: ids vistos → checkout → restrição alimentar → confirmação.
    this.executor = new ToolExecutor(
      this.registry,
      [
        new UnseenIdsGate(this.registry, this.logger),
        new CheckoutGate(groupTools, this.logger),
        new DietGate(dietTools, this.logger),
        new ConfirmGate(),
        new GroupConfirmGate(groupTools),
      ],
      new CartSyncHook(mcp, groupTools, this.logger),
      this.logger,
    );
    this.finalizer = new ReplyFinalizer(this.logger);
  }

  withConfirmation(reply: string, pending?: PendingAction): string {
    return this.finalizer.withConfirmation(reply, pending);
  }

  // Lança McpUnauthorizedError (depois de gravar o que já rodou) quando o iFood recusa o token.
  async run(input: TurnInput): Promise<TurnResult> {
    const { anthropic, mcp, store, groupTools, dietTools, traces, config } =
      this.deps;
    const { chatId, userId } = input;
    const ctx = new TurnContext(
      { chatId, userId, ownerName: input.ownerName },
      (tool) => groupTools.orderView(tool),
    );
    // Preenchido ao entrar no loop; usado para não perder o que já foi executado se o turno falhar.
    let transcript: TurnTranscript | undefined;
    const saveTurn = async () => {
      if (!transcript) return;
      transcript.saved = true;
      await store.saveTurn(chatId, userId, transcript.turn());
    };
    const done = (text: string, images: ReplyImage[] = []): TurnResult => ({
      text: this.finalizer.withConfirmation(text, ctx.pendingAction),
      images,
      pending: ctx.pendingAction,
    });

    const startedAt = new Date();
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let rounds = 0;
    let outcome = 'error';
    let traceError: string | null = null;

    try {
      const session = await mcp.getSession(chatId, input.token);
      // Já inclui a mensagem do usuário gravada pela fachada.
      transcript = new TurnTranscript(await store.recent(chatId));
      ctx.begin(session, transcript.messages);
      ctx.setStateBlock(await this.stateBlock(ctx));
      const tools = cachedTools(
        this.registry.definitions(
          ctx,
          await groupTools.checkoutAllowed(userId),
        ),
      );
      // Política de restrição alimentar: só entra no prompt de quem declarou uma restrição.
      let dietPolicy = policyFor(await dietTools.list(userId));
      let retried = false;

      if (input.confirmed) {
        const confirmed = input.confirmed;
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
        transcript.push({ role: 'assistant', content: [block] });
        transcript.push({
          role: 'user',
          content: await this.executor.run([block], ctx, true),
        });
      }

      for (let round = 0; round < config.maxToolRounds; round++) {
        rounds = round + 1;
        if (ctx.takeDietChanged()) {
          dietPolicy = policyFor(await dietTools.list(userId));
        }
        this.logger.log(
          `[agent] rodada ${round + 1}: chamando LLM (${transcript.messages.length} mensagens no contexto)`,
        );
        const params = {
          model: config.model,
          max_tokens: config.maxTokens,
          output_config: { effort: config.effort },
          system: cachedSystem(SYSTEM_PROMPT, dietPolicy),
          tools,
          messages: cachedMessages(
            withState(
              transcript.messages,
              transcript.userIndex,
              ctx.stateBlock,
            ),
          ),
        };
        const response: Message = await anthropic.messages.create(
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
          transcript.push({
            role: 'assistant',
            content: [{ type: 'text', text: REFUSAL_REPLY }],
          });
          await saveTurn();
          outcome = 'refusal';
          return done([REFUSAL_REPLY, ...ctx.appendices].join('\n\n'));
        }

        if (response.stop_reason !== 'tool_use') {
          const final = await this.finalizer.finalize(
            response,
            ctx,
            transcript,
            {
              retried,
              canRetry: !retried && round + 1 < config.maxToolRounds,
            },
          );
          if (final.kind === 'retry') {
            retried = true;
            continue;
          }
          await saveTurn();
          outcome = 'reply';
          this.logger.log(
            `[agent] resposta final para o chat ${chatId} após ${round + 1} rodada(s) (${final.text.length} chars)`,
          );
          return done(final.text, final.images);
        }

        transcript.push({ role: 'assistant', content: response.content });
        transcript.push({
          role: 'user',
          content: await this.executor.run(response.content, ctx),
        });
      }

      this.logger.warn(
        `Limite de ${config.maxToolRounds} rodadas de ferramentas atingido para o chat ${chatId}`,
      );
      transcript.push({
        role: 'assistant',
        content: [{ type: 'text', text: FALLBACK_REPLY }],
      });
      await saveTurn();
      outcome = 'tool_limit';
      return done([FALLBACK_REPLY, ...ctx.appendices].join('\n\n'));
    } catch (err) {
      traceError = String(err);
      // Ferramentas já executadas (itens no carrinho, pedido fechado) precisam ficar no histórico,
      // senão o LLM não sabe delas na próxima mensagem e repete a ação.
      if (transcript && !transcript.saved && transcript.hasTurn) {
        await saveTurn().catch((saveErr) =>
          this.logger.error(
            `[agent] falha ao gravar turno parcial do chat ${chatId}: ${String(saveErr)}`,
          ),
        );
      }
      if (err instanceof McpUnauthorizedError) throw err;
      if (ctx.appendices.length > 0) {
        // O pedido já foi confirmado e os links existem: entrega-os em vez de só dar erro.
        this.logger.error(
          `[agent] turno do chat ${chatId} falhou depois de gerar links: ${String(err)}`,
        );
        return {
          text: [FALLBACK_REPLY, ...ctx.appendices].join('\n\n'),
          images: [],
        };
      }
      throw err;
    } finally {
      void traces.record({
        chatId,
        userId,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        rounds,
        outcome,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        tools: ctx.trace,
        validatorHits: ctx.validatorHits,
        error: traceError,
      });
    }
  }

  // Estado do pedido lido do banco no começo do turno. Sem conseguir ler, o turno segue sem ele.
  private async stateBlock(ctx: TurnContext): Promise<string> {
    try {
      return orderStateBlock(await ctx.orderView(), ctx.ownerName);
    } catch (err) {
      this.logger.warn(
        `[agent] não consegui ler o estado do pedido do chat ${ctx.chatId}: ${String(err)}`,
      );
      return '';
    }
  }
}
