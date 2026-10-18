import type { Logger } from '@nestjs/common';
import type { GroupOrderTools } from '../../../group-order/index.js';
import { wrapToolResult } from '../../tool-envelope.js';
import type { TurnContext } from '../../turn/turn-context.js';
import type {
  ToolCall,
  ToolHandler,
  ToolOutcome,
  ToolSource,
} from '../tool-handler.js';

// Alteram os carrinhos do pedido: a resposta leva o resumo do pedido.
const CART_TOOLS = new Set(['group_sync_cart', 'group_assign_payer']);

// group_*: pedido em grupo (adapta GroupOrderTools). Erro inesperado (ex.: banco) vira
// tool_result: o lote nunca fica incompleto.
export class GroupSource implements ToolSource {
  constructor(
    private readonly groupTools: GroupOrderTools,
    private readonly logger: Logger,
  ) {}

  handler(name: string): ToolHandler | null {
    if (!this.groupTools.has(name)) return null;
    return {
      name,
      origin: 'group',
      cartWrite: false,
      execute: async (
        call: ToolCall,
        ctx: TurnContext,
      ): Promise<ToolOutcome> => {
        try {
          const local = await this.groupTools.execute(
            call.name,
            call.input,
            ctx.tool,
          );
          ctx.markOrderChanged();
          if (local.appendix) ctx.addAppendix(local.appendix);
          if (!local.isError && CART_TOOLS.has(call.name)) {
            ctx.markCartChanged();
          }
          // Carrega nomes de itens/participantes vindos do catálogo ou do usuário: é dado, não ordem.
          return {
            text: wrapToolResult(call.name, local.text),
            isError: local.isError,
          };
        } catch (err) {
          this.logger.error(
            `[agent] falha inesperada em ${call.name}: ${String(err)}`,
          );
          return {
            text: `Erro interno ao executar ${call.name}. Tente novamente.`,
            isError: true,
          };
        }
      },
    };
  }
}
