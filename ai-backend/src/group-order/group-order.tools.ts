import { Injectable, Logger } from '@nestjs/common';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { GroupOrderError } from './group-order.errors.js';
import {
  GroupOrderService,
  type OrderView,
  type SyncCartInput,
  type SyncCartResult,
} from './group-order.service.js';
import { appConfig } from '../config/app-config.js';
import {
  optionalInt,
  parseSyncCart,
  str,
  type Input,
} from './group-order.input.js';
import { GROUP_TOOL_NAMES, GROUP_TOOLS } from './group-order.tool-defs.js';

export interface ToolContext {
  chatId: number;
  userId: number;
}

export interface LocalToolResult {
  text: string;
  isError: boolean;
  // Texto que o agent anexa, sem alterar, ao fim da resposta ao usuário (ex.: links de
  // pagamento). Evita que o LLM reescreva e estrague um link.
  appendix?: string;
}

// Antes de executar uma ferramenta local o agent pergunta o que fazer:
//   run     → executa direto
//   confirm → ação sensível: só roda depois do /confirmar do usuário; `summary` é o que ele vê
//   reject  → inválida agora; devolve o motivo ao LLM sem incomodar o usuário
export type Preparation =
  | { kind: 'run' }
  | { kind: 'confirm'; summary: string }
  | { kind: 'reject'; error: string };

const ok = (
  value: unknown,
  extra: Partial<LocalToolResult> = {},
): LocalToolResult => ({
  text: JSON.stringify(value),
  isError: false,
  ...extra,
});

// Resultado do group_confirm_order: o LLM recebe os valores e uma nota; os links vão como apêndice
// da resposta, montados aqui, para o modelo não reescrevê-los.
function confirmReply(
  result: Awaited<ReturnType<GroupOrderService['confirmOrder']>>,
): LocalToolResult {
  const lines = result.links.map(
    (l) =>
      `• ${l.participant} — ${l.amount} (${l.restaurant}): [abrir pagamento](${l.url})`,
  );
  const note = [
    result.links.length
      ? 'Os links de pagamento serão anexados automaticamente à sua resposta: NÃO os escreva nem os repita. Diga o valor de cada pessoa e que cada uma deve abrir o seu link.'
      : null,
    result.failed.length
      ? `Não consegui gerar o link de: ${result.failed.join(', ')}. O pedido está confirmado; chame group_confirm_order de novo para tentar outra vez.`
      : null,
  ]
    .filter(Boolean)
    .join(' ');
  return ok(
    {
      confirmed: true,
      already_confirmed: result.alreadyConfirmed,
      payments: result.payments,
      links_attached: result.links.length,
      failed_links: result.failed,
      note,
    },
    lines.length
      ? {
          appendix: `**Links de pagamento** (cada pessoa abre o seu):\n${lines.join('\n')}`,
        }
      : {},
  );
}

@Injectable()
export class GroupOrderTools {
  private readonly logger = new Logger(GroupOrderTools.name);

  constructor(private readonly orders: GroupOrderService) {}

  readonly definitions: Tool[] = GROUP_TOOLS;

  has(name: string): boolean {
    return GROUP_TOOL_NAMES.has(name);
  }

  // Ferramentas do iFood + as locais. As locais vencem em caso de nome repetido. O checkout fica
  // sempre na lista (a lista não muda quando o pedido é pago, e o prefixo do cache se mantém): a
  // trava de verdade é checkMcpCall, no momento da chamada.
  mergeTools(mcpTools: Tool[]): Tool[] {
    const visible = mcpTools.filter((tool) => {
      if (!GROUP_TOOL_NAMES.has(tool.name)) return true;
      this.logger.warn(
        `Ferramenta do MCP "${tool.name}" ignorada: nome reservado pelo pedido em grupo`,
      );
      return false;
    });
    return [...visible, ...this.definitions];
  }

  // group_confirm_order gera cobranças para outras pessoas: exige o /confirmar do usuário, e o
  // código (não o LLM) mostra quanto cada um vai pagar. Reenviar links de um pedido já confirmado
  // não cobra nada de novo, então roda direto.
  async prepare(ctx: ToolContext, name: string): Promise<Preparation> {
    if (name !== 'group_confirm_order') return { kind: 'run' };
    try {
      const view = await this.orders.getOrderView(ctx.userId);
      if (!view.order)
        return { kind: 'reject', error: 'Não há pedido em andamento.' };
      if (view.order.status === 'paying') return { kind: 'run' };
      if (view.problems?.length)
        return { kind: 'reject', error: view.problems.join(' ') };
      const preview = view.amounts_preview ?? [];
      if (preview.length === 0) {
        return {
          kind: 'reject',
          error: 'O pedido não tem carrinhos com pagadores definidos.',
        };
      }
      return {
        kind: 'confirm',
        summary: [
          'Vou gerar uma cobrança para cada pessoa:',
          ...preview.map((p) => `• ${p.participant} — ${p.total} (${p.cart})`),
        ].join('\n'),
      };
    } catch (err) {
      this.logger.error(`[group] erro ao preparar ${name}: ${String(err)}`);
      return {
        kind: 'reject',
        error: 'Erro interno ao preparar a confirmação. Tente novamente.',
      };
    }
  }

  // Sync automático (ver agent/cart-sync.ts): os números vêm do getCart, não do LLM.
  syncIfoodCart(
    ctx: ToolContext,
    input: SyncCartInput,
  ): Promise<SyncCartResult> {
    return this.orders.syncCart(ctx.userId, input);
  }

  orderView(ctx: ToolContext): Promise<OrderView> {
    return this.orders.getOrderView(ctx.userId);
  }

  isCheckoutTool(name: string): boolean {
    return appConfig().mcp.checkoutToolPattern.test(name);
  }

  // Barreira no momento da chamada (o modelo pode alucinar uma ferramenta escondida ou apontar
  // para o carrinho errado). Devolve o motivo do bloqueio, ou null se pode seguir.
  async checkMcpCall(
    ctx: ToolContext,
    name: string,
    input: unknown,
  ): Promise<string | null> {
    if (!this.isCheckoutTool(name)) return null;
    if (!(await this.orders.hasPaidOrder(ctx.userId))) {
      return 'Checkout bloqueado: o pedido ainda não foi totalmente pago. Aguarde todos os pagamentos.';
    }
    // Se a chamada cita um carrinho ainda não pago, bloqueia (não dá para saber o formato do
    // argumento de cada ferramenta, então procuramos os ids conhecidos no JSON inteiro).
    const serialized = JSON.stringify(input ?? {});
    const unpaid = (await this.orders.openIfoodCartIds(ctx.userId)).find((id) =>
      serialized.includes(id),
    );
    if (unpaid) {
      return `Checkout bloqueado: o carrinho ${unpaid} ainda não foi pago. Finalize só os carrinhos listados em awaiting_finalization.`;
    }
    return null;
  }

  async execute(
    name: string,
    rawInput: unknown,
    ctx: ToolContext,
  ): Promise<LocalToolResult> {
    const input = (
      rawInput && typeof rawInput === 'object' ? rawInput : {}
    ) as Input;
    try {
      switch (name) {
        case 'group_get_order':
          return ok(await this.orders.getOrderView(ctx.userId));

        case 'group_add_participant':
          return ok(
            await this.orders.addParticipant(
              ctx.userId,
              str(input, 'name', 60),
            ),
          );

        case 'group_sync_cart':
          return ok(
            await this.orders.syncCart(ctx.userId, parseSyncCart(input)),
          );

        case 'group_assign_payer':
          return ok(
            await this.orders.assignPayer(ctx.userId, {
              ifoodCartId: str(input, 'ifood_cart_id', 200),
              itemId: str(input, 'item_id', 200),
              participantName: str(input, 'participant_name', 60),
            }),
          );

        case 'group_confirm_order':
          return confirmReply(await this.orders.confirmOrder(ctx.userId));

        case 'group_reopen_order':
          return ok(await this.orders.reopenOrder(ctx.userId));

        case 'group_cancel_order':
          return ok(await this.orders.cancelOrder(ctx.userId));

        case 'group_mark_finalized':
          return ok(
            await this.orders.markFinalized(
              ctx.userId,
              optionalInt(input, 'order_id'),
            ),
          );

        default:
          return { text: `Ferramenta desconhecida: ${name}`, isError: true };
      }
    } catch (err) {
      if (err instanceof GroupOrderError)
        return { text: err.message, isError: true };
      this.logger.error(
        `[group] erro inesperado em ${name}: ${String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      return {
        text: 'Erro interno ao executar a ferramenta. Tente novamente.',
        isError: true,
      };
    }
  }
}
