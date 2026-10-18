import type { GroupOrderTools } from '../../../group-order/group-order.tools.js';
import { wrapToolResult } from '../../tool-envelope.js';
import type { TurnContext } from '../../turn/turn-context.js';
import type { ToolCall, ToolHandler } from '../tool-handler.js';
import type { Preparation, ToolGate } from './gate.js';

// Ferramentas do pedido em grupo que cobram pessoas (group_confirm_order) passam pelo mesmo
// /confirmar das ferramentas sensíveis do iFood; o resumo de quem paga quanto é do código.
export class GroupConfirmGate implements ToolGate {
  readonly name = 'pedido-em-grupo';
  readonly skipWhenConfirmed = true;

  constructor(private readonly groupTools: GroupOrderTools) {}

  appliesTo(handler: ToolHandler): boolean {
    return handler.origin === 'group';
  }

  async check(call: ToolCall, ctx: TurnContext): Promise<Preparation> {
    const preparation = await this.groupTools.prepare(ctx.tool, call.name);
    return preparation.kind === 'reject'
      ? { kind: 'reject', error: wrapToolResult(call.name, preparation.error) }
      : preparation;
  }

  unavailable(call: ToolCall): string {
    return `Erro interno ao executar ${call.name}. Tente novamente.`;
  }
}
