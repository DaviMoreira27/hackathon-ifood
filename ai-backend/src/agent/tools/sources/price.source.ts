import { GroupOrderError } from '../../../group-order/group-order.errors.js';
import { comparePrices, isPriceTool, priceFacts } from '../../price-tools.js';
import { wrapToolResult } from '../../tool-envelope.js';
import type { TurnContext } from '../../turn/turn-context.js';
import type {
  ToolCall,
  ToolHandler,
  ToolOutcome,
  ToolSource,
} from '../tool-handler.js';

// compare_prices: conta feita pelo código com os preços que as ferramentas devolveram na conversa.
export class PriceSource implements ToolSource {
  handler(name: string): ToolHandler | null {
    if (!isPriceTool(name)) return null;
    return {
      name,
      origin: 'price',
      cartWrite: false,
      execute: async (
        call: ToolCall,
        ctx: TurnContext,
      ): Promise<ToolOutcome> => {
        try {
          return {
            text: wrapToolResult(
              call.name,
              comparePrices(call.rawInput, priceFacts(ctx.messages)),
            ),
            isError: false,
          };
        } catch (err) {
          return {
            text:
              err instanceof GroupOrderError
                ? err.message
                : `Erro interno ao executar ${call.name}.`,
            isError: true,
          };
        }
      },
    };
  }
}
