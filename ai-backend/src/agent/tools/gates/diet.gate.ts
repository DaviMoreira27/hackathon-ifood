import type { Logger } from '@nestjs/common';
import type { DietaryTools } from '../../../dietary/index.js';
import type { TurnContext } from '../../turn/turn-context.js';
import type { ToolCall, ToolHandler } from '../tool-handler.js';
import type { Preparation, ToolGate } from './gate.js';

// Trava da restrição alimentar: item não verificado é recusado, item cortado pede /confirmar.
export class DietGate implements ToolGate {
  readonly name = 'restricao-alimentar';
  readonly skipWhenConfirmed = true;

  constructor(
    private readonly dietTools: DietaryTools,
    private readonly logger: Logger,
  ) {}

  appliesTo(handler: ToolHandler): boolean {
    return handler.origin === 'mcp';
  }

  async check(call: ToolCall, ctx: TurnContext): Promise<Preparation> {
    const diet = await this.dietTools.prepareMcpCall(
      ctx.tool,
      call.name,
      call.input,
    );
    if (diet.kind === 'reject') {
      this.logger.warn(
        `[agent] chamada a ${call.name} barrada pela restrição alimentar`,
      );
    }
    return diet;
  }

  // Sem conseguir checar as restrições, o item não entra.
  unavailable(call: ToolCall): string {
    return `Não consegui verificar as restrições alimentares agora; ${call.name} não foi executada. Tente novamente.`;
  }
}
