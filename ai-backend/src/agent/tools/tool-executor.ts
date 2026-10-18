import type { Logger } from '@nestjs/common';
import type {
  ContentBlock,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages.js';
import { isObj } from '../../common/json.js';
import { McpUnauthorizedError } from '../../mcp/mcp.service.js';
import type { TurnContext } from '../turn/turn-context.js';
import type { ToolGate } from './gates/gate.js';
import type { CartSyncHook } from './hooks/cart-sync.hook.js';
import type { ToolCall, ToolOutcome } from './tool-handler.js';
import type { ToolRegistry } from './tool-registry.js';

const BLOCKED_RESULT =
  'BLOQUEADO: esta ação exige confirmação explícita do usuário. O sistema já anexa à sua resposta o pedido de confirmação (o usuário responde "confirmar"). Não chame a ferramenta de novo, não repita a instrução de confirmação nem cite nomes de ferramentas ou ids; explique em linguagem simples o que vai acontecer e aguarde.';
const ALREADY_PENDING_RESULT =
  'BLOQUEADO: já existe outra ação aguardando confirmação do usuário neste turno. Uma ação sensível por vez.';
const EXPIRED_RESULT = 'Não executada: sessão do iFood expirou.';

const error = (text: string): ToolOutcome => ({ text, isError: true });

// Executa os tool_use de uma resposta do LLM: resolve a ferramenta no registry, passa pela cadeia
// de gates, executa e roda o hook de sync do carrinho. Nunca lança no meio: cada tool_use recebe
// um tool_result (inclusive os que não rodaram), e um 401 só é relançado depois, com o lote
// completo em mãos.
export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly gates: ToolGate[],
    private readonly cartSync: CartSyncHook,
    private readonly logger: Logger,
  ) {}

  async run(
    content: ContentBlock[],
    ctx: TurnContext,
    preApproved = false,
  ): Promise<ToolResultBlockParam[]> {
    const uses = content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    );
    // Várias leituras pedidas juntas (ex.: o mesmo prato em três lojas) rodam em paralelo, cada
    // uma pelo caminho normal. Escritas ficam em série (mesmo carrinho, ordem importa).
    if (
      uses.length > 1 &&
      uses.every((b) => this.registry.isReadOnly(b.name, ctx))
    ) {
      const settled = await Promise.all(
        uses.map((b) => this.runOne(b, ctx, preApproved)),
      );
      const unauthorized = settled.find((s) => s.unauthorized)?.unauthorized;
      if (unauthorized) throw unauthorized;
      return settled.map((s) => s.result);
    }

    const results: ToolResultBlockParam[] = [];
    let unauthorized: McpUnauthorizedError | undefined;
    for (const block of uses) {
      if (unauthorized) {
        results.push(this.emit(block, error(EXPIRED_RESULT), ctx, Date.now()));
        continue;
      }
      const ran = await this.runOne(block, ctx, preApproved);
      unauthorized = ran.unauthorized;
      results.push(ran.result);
    }
    if (unauthorized) throw unauthorized;
    return results;
  }

  private async runOne(
    block: ToolUseBlock,
    ctx: TurnContext,
    preApproved: boolean,
  ): Promise<{
    result: ToolResultBlockParam;
    unauthorized?: McpUnauthorizedError;
  }> {
    const startedAt = Date.now();
    try {
      const outcome = await this.outcome(block, ctx, preApproved);
      return { result: this.emit(block, outcome, ctx, startedAt) };
    } catch (err) {
      if (!(err instanceof McpUnauthorizedError)) throw err;
      return {
        result: this.emit(block, error(EXPIRED_RESULT), ctx, startedAt),
        unauthorized: err,
      };
    }
  }

  private async outcome(
    block: ToolUseBlock,
    ctx: TurnContext,
    preApproved: boolean,
  ): Promise<ToolOutcome> {
    this.logger.log(`[agent] LLM pediu a ferramenta ${block.name}`);
    const handler = this.registry.resolve(block.name, ctx);
    if (!handler) return error(`Ferramenta inexistente: ${block.name}`);
    const call: ToolCall = {
      id: block.id,
      name: block.name,
      input: isObj(block.input) ? block.input : {},
      rawInput: block.input,
    };

    for (const gate of this.gates) {
      if (!gate.appliesTo(handler)) continue;
      if (preApproved && gate.skipWhenConfirmed) continue;
      let preparation;
      try {
        preparation = await gate.check(call, ctx);
      } catch (err) {
        this.logger.error(
          `[agent] falha no gate ${gate.name} ao checar ${call.name}: ${String(err)}`,
        );
        return error(gate.unavailable(call));
      }
      if (preparation.kind === 'reject') return error(preparation.error);
      if (preparation.kind === 'confirm') {
        const state = ctx.requestConfirmation({
          name: call.name,
          input: call.input,
          summary: preparation.summary || undefined,
        });
        if (state === 'already-pending') return error(ALREADY_PENDING_RESULT);
        this.logger.log(
          `[agent] ${call.name} aguardando /confirmar do chat ${ctx.chatId} (${gate.name})`,
        );
        return error(BLOCKED_RESULT);
      }
    }

    const outcome = await handler.execute(call, ctx);
    if (handler.cartWrite && !outcome.isError) {
      const note = await this.cartSync.afterWrite(
        call,
        outcome.raw ?? outcome.text,
        ctx,
      );
      return { ...outcome, text: `${outcome.text}\n${note}` };
    }
    return outcome;
  }

  // Todo resultado passa por aqui: entra no trace e, se deu certo, na lista do turno.
  private emit(
    block: ToolUseBlock,
    outcome: ToolOutcome,
    ctx: TurnContext,
    startedAt: number,
  ): ToolResultBlockParam {
    ctx.recordTool(block.name, !outcome.isError, Date.now() - startedAt);
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: outcome.text,
      is_error: outcome.isError,
    };
  }
}
