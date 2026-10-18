import type { Logger } from '@nestjs/common';
import { unseenIds } from '../../reply-check.js';
import type { TurnContext } from '../../turn/turn-context.js';
import type { ToolCall, ToolHandler } from '../tool-handler.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { Preparation, ToolGate } from './gate.js';

// Registro de ids vistos: escrita com id que nunca apareceu num resultado de ferramenta (ou no
// estado do pedido) é recusada antes do MCP. Pega id inventado e id de outra conversa.
export class UnseenIdsGate implements ToolGate {
  readonly name = 'ids-vistos';
  readonly skipWhenConfirmed = true;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly logger: Logger,
  ) {}

  appliesTo(handler: ToolHandler): boolean {
    return handler.origin === 'mcp';
  }

  check(call: ToolCall, ctx: TurnContext): Promise<Preparation> {
    if (this.registry.isReadOnly(call.name, ctx)) {
      return Promise.resolve({ kind: 'run' });
    }
    const unseen = unseenIds(call.input, ctx.facts);
    if (unseen.length === 0) return Promise.resolve({ kind: 'run' });
    const list = unseen.map((u) => `${u.key}=${u.value}`).join(', ');
    this.logger.warn(
      `[agent] chamada a ${call.name} barrada: ids nunca vistos (${list})`,
    );
    ctx.recordValidatorHit(`id:${call.name}:${list}`);
    return Promise.resolve({
      kind: 'reject',
      error: `Recusado pelo sistema: ${list} não apareceu em nenhum resultado de ferramenta desta conversa. Consulte antes (ex.: getCart, getMerchant, listAddresses) e use o id exato que a ferramenta devolveu.`,
    });
  }

  unavailable(call: ToolCall): string {
    return `Erro interno ao executar ${call.name}. Tente novamente.`;
  }
}
