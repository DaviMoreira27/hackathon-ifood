import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { DIET_TOOLS } from '../../dietary/dietary.tools.js';
import type { GroupOrderTools } from '../../group-order/group-order.tools.js';
import { PRICE_TOOLS } from '../price-tools.js';
import { strictTool } from '../strict-tools.js';
import type { TurnContext } from '../turn/turn-context.js';
import type { ToolHandler, ToolSource } from './tool-handler.js';

// Junta as fontes de ferramentas. A ordem das fontes é a ordem de resolução por nome.
export class ToolRegistry {
  constructor(
    private readonly sources: ToolSource[],
    private readonly groupTools: GroupOrderTools,
  ) {}

  // Ferramentas do iFood + as do pedido em grupo; o checkout só aparece com o pedido pago.
  // As locais vão com strict: os argumentos sempre respeitam o schema.
  definitions(ctx: TurnContext, checkoutAllowed: boolean): Tool[] {
    return [
      ...this.groupTools
        .mergeTools(ctx.session.tools, checkoutAllowed)
        .map((t) => (this.groupTools.has(t.name) ? strictTool(t) : t)),
      ...PRICE_TOOLS.map(strictTool),
      ...DIET_TOOLS.map(strictTool),
    ];
  }

  resolve(name: string, ctx: TurnContext): ToolHandler | null {
    for (const source of this.sources) {
      const handler = source.handler(name, ctx);
      if (handler) return handler;
    }
    return null;
  }

  // Só leitura (anunciado pelo MCP): pode rodar em paralelo e não passa pelo registro de ids.
  isReadOnly(name: string, ctx: TurnContext): boolean {
    return ctx.session.readOnlyTools?.has(name) ?? false;
  }
}
