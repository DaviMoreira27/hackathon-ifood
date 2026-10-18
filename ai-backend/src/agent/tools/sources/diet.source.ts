import type { Logger } from '@nestjs/common';
import type { DietaryTools } from '../../../dietary/index.js';
import { wrapToolResult } from '../../tool-envelope.js';
import type { TurnContext } from '../../turn/turn-context.js';
import type {
  ToolCall,
  ToolHandler,
  ToolOutcome,
  ToolSource,
} from '../tool-handler.js';

// diet_*: restrições alimentares salvas e a checagem de itens (adapta DietaryTools).
export class DietSource implements ToolSource {
  constructor(
    private readonly dietTools: DietaryTools,
    private readonly logger: Logger,
  ) {}

  handler(name: string): ToolHandler | null {
    if (!this.dietTools.has(name)) return null;
    return {
      name,
      origin: 'diet',
      cartWrite: false,
      execute: async (
        call: ToolCall,
        ctx: TurnContext,
      ): Promise<ToolOutcome> => {
        try {
          const local = await this.dietTools.execute(
            call.name,
            call.rawInput,
            ctx.tool,
          );
          ctx.markDietChanged();
          if (local.appendix) ctx.addAppendix(local.appendix);
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
