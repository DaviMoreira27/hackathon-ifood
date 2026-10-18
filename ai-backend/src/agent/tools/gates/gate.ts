import type { Preparation } from '../../../group-order/group-order.tools.js';
import type { TurnContext } from '../../turn/turn-context.js';
import type { ToolCall, ToolHandler } from '../tool-handler.js';

export type { Preparation };

// Uma checagem antes de executar uma ferramenta. O executor percorre os gates na ordem e para no
// primeiro reject (o motivo vai ao LLM) ou confirm (a ação espera o /confirmar do usuário).
export interface ToolGate {
  // Rótulo para os logs.
  readonly name: string;
  // Gates que o /confirmar pula: a ação já foi vista e aprovada pelo usuário.
  readonly skipWhenConfirmed: boolean;
  appliesTo(handler: ToolHandler): boolean;
  check(call: ToolCall, ctx: TurnContext): Promise<Preparation>;
  // Motivo devolvido ao LLM quando a checagem falha de forma inesperada: a ação não roda (lado seguro).
  unavailable(call: ToolCall): string;
}
