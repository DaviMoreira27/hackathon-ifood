import {
  McpUnauthorizedError,
  type McpService,
} from '../../../mcp/mcp.service.js';
import { triggersCartSync } from '../../cart-sync.js';
import { wrapToolResult } from '../../tool-envelope.js';
import type { TurnContext } from '../../turn/turn-context.js';
import type {
  ToolCall,
  ToolHandler,
  ToolOutcome,
  ToolSource,
} from '../tool-handler.js';

// Ferramentas do iFood, pela sessão MCP do chat. Inclui as que estão escondidas do LLM (checkout
// sem pedido pago): se ele chamar mesmo assim, quem barra é o CheckoutGate.
export class McpSource implements ToolSource {
  constructor(private readonly mcp: McpService) {}

  handler(name: string, ctx: TurnContext): ToolHandler | null {
    if (!ctx.session.tools.some((t) => t.name === name)) return null;
    return {
      name,
      origin: 'mcp',
      cartWrite: triggersCartSync(name),
      execute: async (
        call: ToolCall,
        turn: TurnContext,
      ): Promise<ToolOutcome> => {
        try {
          const output = await this.mcp.callTool(
            turn.session,
            call.name,
            call.input,
          );
          return {
            text: wrapToolResult(call.name, output.text),
            isError: output.isError,
            raw: output.text,
          };
        } catch (err) {
          if (err instanceof McpUnauthorizedError) throw err;
          // Timeout/queda de conexão não diz se o servidor aplicou a ação: avisa o LLM para não
          // repetir às cegas (item duplicado, pedido fechado duas vezes). O erro cru fica só no log.
          return {
            text: `Falha de comunicação ao executar ${call.name}. O resultado é DESCONHECIDO: a ação pode ter sido aplicada. Não repita; consulte o estado antes.`,
            isError: true,
          };
        }
      },
    };
  }
}
