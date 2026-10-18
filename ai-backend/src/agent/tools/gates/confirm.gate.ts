import type { TurnContext } from '../../turn/turn-context.js';
import type { ToolCall, ToolHandler } from '../tool-handler.js';
import type { Preparation, ToolGate } from './gate.js';

// Ferramentas sensíveis do iFood (ver tool-policy.ts) só rodam depois do /confirmar.
export class ConfirmGate implements ToolGate {
  readonly name = 'confirmacao';
  readonly skipWhenConfirmed = true;

  appliesTo(handler: ToolHandler): boolean {
    return handler.origin === 'mcp';
  }

  check(call: ToolCall, ctx: TurnContext): Promise<Preparation> {
    return Promise.resolve(
      ctx.session.confirmTools.has(call.name)
        ? { kind: 'confirm', summary: '' }
        : { kind: 'run' },
    );
  }

  unavailable(call: ToolCall): string {
    return `Erro interno ao executar ${call.name}. Tente novamente.`;
  }
}
