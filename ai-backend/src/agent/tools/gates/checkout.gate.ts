import type { Logger } from '@nestjs/common';
import type { GroupOrderTools } from '../../../group-order/group-order.tools.js';
import type { TurnContext } from '../../turn/turn-context.js';
import type { ToolCall, ToolHandler } from '../tool-handler.js';
import type { Preparation, ToolGate } from './gate.js';

// Trava do checkout: só com o pedido pago, e nunca de um carrinho ainda não pago. Vale também
// depois do /confirmar.
export class CheckoutGate implements ToolGate {
  readonly name = 'checkout';
  readonly skipWhenConfirmed = false;

  constructor(
    private readonly groupTools: GroupOrderTools,
    private readonly logger: Logger,
  ) {}

  appliesTo(handler: ToolHandler): boolean {
    return handler.origin === 'mcp';
  }

  async check(call: ToolCall, ctx: TurnContext): Promise<Preparation> {
    const forbidden = await this.groupTools.checkMcpCall(
      ctx.tool,
      call.name,
      call.input,
    );
    if (!forbidden) return { kind: 'run' };
    this.logger.warn(`[agent] chamada a ${call.name} barrada: ${forbidden}`);
    return { kind: 'reject', error: forbidden };
  }

  // Sem conseguir checar o pagamento, o checkout não roda.
  unavailable(call: ToolCall): string {
    return `Não consegui verificar o estado dos pagamentos agora; ${call.name} não foi executada. Tente novamente.`;
  }
}
