import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
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
import {
  DIET_TOOLS,
  DietaryTools,
  policyFor,
} from '../dietary/dietary.tools.js';
import { messagesToRows, rowsToMessages } from './history.js';
import { imageCatalog, takeImages, type ReplyImage } from './images.js';
import { comparePrices, isPriceTool, PRICE_TOOLS } from './price-tools.js';
import { cachedMessages, cachedSystem, cachedTools } from './prompt-cache.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { wrapToolResult } from './tool-policy.js';

export const ANTHROPIC_CLIENT = Symbol('ANTHROPIC_CLIENT');

const MODEL = 'claude-haiku-5-5';
// O Haiku 5.5 pensa (adaptive thinking) por padrão, e o raciocínio conta neste limite: com 4096
// uma resposta longa podia parar em max_tokens antes do texto.
const MAX_TOKENS = 16000;
// Comparar preços pede algumas buscas a mais; leituras pedidas juntas rodam em paralelo.
const MAX_TOOL_ROUNDS = 12;
// Quantas linhas da tabela messages entram no contexto do LLM.
const HISTORY_ROWS = 40;
// Resultados de ferramentas de mensagens anteriores entram encurtados no contexto.
const HISTORY_TOOL_RESULT_CHARS = 4000;
// Mensagens do mesmo chat esperando na fila: acima disso, o usuário recebe "aguarde"
// em vez de enfileirar mais chamadas ao LLM (custo) e ao MCP.
const MAX_QUEUED_PER_CHAT = 3;
const CONFIRM_TTL_MS = 5 * 60 * 1000;
const CONFIRM_COMMAND = '/confirmar';

const FALLBACK_REPLY = 'Desculpe, ocorreu um erro interno. Tente novamente.';
const BUSY_REPLY =
  'Ainda estou processando suas mensagens anteriores. Aguarde a resposta antes de mandar outra.';
// O link de login tem um state de uso único: o que fica no histórico é só um marcador.
const LOGIN_MARKER = '[link de login do iFood enviado]';
const BLOCKED_RESULT =
  'BLOQUEADO: esta ação exige confirmação explícita do usuário. O sistema já mostrou os detalhes e pediu que ele responda /confirmar. Não chame a ferramenta de novo; explique o que vai acontecer e aguarde.';
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
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

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
    if (command === CONFIRM_COMMAND) {
      if (!pending || pending.expiresAt < Date.now()) {
        return 'Não há nenhuma ação aguardando confirmação (ou ela expirou). Peça de novo, por favor.';
      }
      confirmed = pending;
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
    let persisted = false;
    const saveTurn = async () => {
      persisted = true;
      // O turno inteiro (tool_use, tool_result e resposta) é gravado de uma vez,
      // para o histórico nunca ficar com uma chamada de ferramenta sem resultado.
      await this.messages.addMany(messagesToRows(chatId, user.id, turn));
    };

    // Fora do try: se o turno falhar depois de gerar os links, eles ainda chegam ao usuário.
    const appendices: string[] = [];

    try {
      const session = await this.mcp.getSession(chatId, token);
      // Já inclui a mensagem do usuário gravada acima.
      const messages = rowsToMessages(
        await this.messages.recent(chatId, HISTORY_ROWS),
        HISTORY_TOOL_RESULT_CHARS,
      );
      const turnStart = messages.length;
      const state: TurnState = { ctx: { chatId, userId: user.id }, appendices };
      // Ferramentas do iFood + as do pedido em grupo; o checkout só aparece com o pedido pago.
      const tools = cachedTools([
        ...this.groupTools.mergeTools(
          session.tools,
          await this.groupTools.checkoutAllowed(user.id),
        ),
        ...PRICE_TOOLS,
        ...DIET_TOOLS,
      ]);
      // Política de restrição alimentar: só entra no prompt de quem declarou uma restrição.
      let dietPolicy = policyFor(await this.dietTools.list(user.id));
      const push = (message: MessageParam) => {
        messages.push(message);
        turn = messages.slice(turnStart);
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

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (state.dietChanged) {
          dietPolicy = policyFor(await this.dietTools.list(user.id));
          state.dietChanged = false;
        }
        this.logger.log(
          `[agent] rodada ${round + 1}: chamando LLM (${messages.length} mensagens no contexto)`,
        );
        const response = await this.anthropic.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: cachedSystem(SYSTEM_PROMPT, dietPolicy),
          tools,
          messages: cachedMessages(messages),
        });
        this.logger.log(
          `[agent] LLM respondeu stop_reason=${response.stop_reason} (tokens in=${response.usage?.input_tokens} cache_read=${response.usage?.cache_read_input_tokens ?? 0} cache_write=${response.usage?.cache_creation_input_tokens ?? 0} out=${response.usage?.output_tokens})`,
        );

        if (response.stop_reason !== 'tool_use') {
          // Com max_tokens o modelo pode parar no meio de um tool_use. Ele não é executado, então
          // não pode ir para o histórico: um tool_use sem tool_result quebra todas as próximas chamadas.
          push({
            role: 'assistant',
            content: response.content.filter((b) => b.type !== 'tool_use'),
          });
          // As fotos saem do texto e vão como imagens; só valem URLs que vieram das ferramentas.
          const { text, images: chosen } = takeImages(
            response.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n'),
            imageCatalog(messages),
          );
          images.push(...chosen);
          const reply = [
            text || (appendices.length ? '' : FALLBACK_REPLY),
            ...appendices,
          ]
            .filter(Boolean)
            .join('\n\n');
          await saveTurn();
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
        `Limite de ${MAX_TOOL_ROUNDS} rodadas de ferramentas atingido para o chat ${chatId}`,
      );
      push({
        role: 'assistant',
        content: [{ type: 'text', text: FALLBACK_REPLY }],
      });
      await saveTurn();
      return this.withConfirmation(
        chatId,
        [FALLBACK_REPLY, ...appendices].join('\n\n'),
        state,
      );
    } catch (err) {
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

      if (unauthorized) {
        results.push(result('Não executada: sessão do iFood expirou.', true));
        continue;
      }
      this.logger.log(`[agent] LLM pediu a ferramenta ${block.name}`);

      if (isPriceTool(block.name)) {
        try {
          results.push(
            result(
              wrapToolResult(block.name, comparePrices(block.input)),
              false,
            ),
          );
        } catch (err) {
          results.push(
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
          results.push(
            result(wrapToolResult(block.name, local.text), local.isError),
          );
        } catch (err) {
          this.logger.error(
            `[agent] falha inesperada em ${block.name}: ${String(err)}`,
          );
          results.push(
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
        results.push(result(`Ferramenta inexistente: ${block.name}`, true));
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
              results.push(
                result(wrapToolResult(block.name, preparation.error), true),
              );
              continue;
            }
            if (preparation.kind === 'confirm') {
              if (state.pending) {
                results.push(result(ALREADY_PENDING_RESULT, true));
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
              results.push(result(BLOCKED_RESULT, true));
              continue;
            }
          }
          const local = await this.groupTools.execute(
            block.name,
            input,
            state.ctx,
          );
          if (local.appendix) state.appendices.push(local.appendix);
          // Carrega nomes de itens/participantes vindos do catálogo ou do usuário: é dado, não ordem.
          results.push(
            result(wrapToolResult(block.name, local.text), local.isError),
          );
        } catch (err) {
          this.logger.error(
            `[agent] falha inesperada em ${block.name}: ${String(err)}`,
          );
          results.push(
            result(
              `Erro interno ao executar ${block.name}. Tente novamente.`,
              true,
            ),
          );
        }
        continue;
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
        results.push(result(forbidden, true));
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
          results.push(result(diet.error, true));
          continue;
        }
        if (diet.kind === 'confirm') {
          if (state.pending) {
            results.push(result(ALREADY_PENDING_RESULT, true));
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
          results.push(result(BLOCKED_RESULT, true));
          continue;
        }
      }

      if (session.confirmTools.has(block.name) && !preApproved) {
        if (state.pending) {
          results.push(result(ALREADY_PENDING_RESULT, true));
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
        results.push(result(BLOCKED_RESULT, true));
        continue;
      }

      try {
        const output = await this.mcp.callTool(session, block.name, input);
        results.push(
          result(wrapToolResult(block.name, output.text), output.isError),
        );
      } catch (err) {
        if (err instanceof McpUnauthorizedError) {
          unauthorized = err;
          results.push(result('Não executada: sessão do iFood expirou.', true));
          continue;
        }
        // Timeout/queda de conexão não diz se o servidor aplicou a ação: avisa o LLM para não
        // repetir às cegas (item duplicado, pedido fechado duas vezes). O erro cru fica só no log.
        results.push(
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
    let details = JSON.stringify(state.pending.input, null, 2);
    if (details.length > 1500) details = `${details.slice(0, 1500)}\n…`;
    return [
      reply,
      '',
      '⚠️ **Confirmação necessária**',
      `Ação: \`${state.pending.name}\``,
      ...(state.pending.summary
        ? [state.pending.summary]
        : ['```', details, '```']),
      `Responda ${CONFIRM_COMMAND} em até 5 minutos para executar exatamente isso. Qualquer outra mensagem cancela.`,
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
