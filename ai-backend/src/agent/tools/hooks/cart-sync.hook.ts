import type { Logger } from '@nestjs/common';
import { GroupOrderError } from '../../../group-order/group-order.errors.js';
import type { GroupOrderTools } from '../../../group-order/group-order.tools.js';
import { formatBRL, toCents } from '../../../group-order/money.js';
import type { McpService } from '../../../mcp/mcp.service.js';
import { cartIdOf, GET_CART, getCartArgs, parseCart } from '../../cart-sync.js';
import { wrapToolResult } from '../../tool-envelope.js';
import type { TurnContext } from '../../turn/turn-context.js';
import type { ToolCall } from '../tool-handler.js';

export interface CartWrite {
  call: ToolCall;
  // Saída da ferramenta antes do envelope (de onde sai o cartId quando o input não traz).
  output: string;
}

const SYNCED_LATER =
  'Sistema: este carrinho é sincronizado com o pedido em grupo uma vez, ao final deste lote (ver o resultado da última alteração dele).';

// Sync automático (ver cart-sync.ts): depois das escritas bem-sucedidas num lote, lê cada carrinho
// alterado uma vez com getCart e registra no pedido em grupo. Devolve, por tool_use, a nota que o
// LLM lê junto com o resultado; em qualquer falha, a nota manda usar group_sync_cart.
export class CartSyncHook {
  constructor(
    private readonly mcp: McpService,
    private readonly groupTools: GroupOrderTools,
    private readonly logger: Logger,
  ) {}

  async afterWrites(
    writes: CartWrite[],
    ctx: TurnContext,
  ): Promise<Map<string, string>> {
    const notes = new Map<string, string>();
    const byCart = new Map<string, CartWrite[]>();
    for (const write of writes) {
      const cartId = cartIdOf(write.call.input, write.output);
      if (!cartId) {
        notes.set(
          write.call.id,
          this.fallback(write.call, 'cartId não identificado', ctx),
        );
        continue;
      }
      byCart.set(cartId, [...(byCart.get(cartId) ?? []), write]);
    }
    // Em série: cada sync trava o pedido no banco.
    for (const [cartId, group] of byCart) {
      const last = group[group.length - 1];
      for (const write of group.slice(0, -1)) {
        notes.set(write.call.id, SYNCED_LATER);
      }
      notes.set(last.call.id, await this.sync(last.call, cartId, ctx));
    }
    return notes;
  }

  private fallback(call: ToolCall, reason: string, ctx: TurnContext): string {
    this.logger.warn(
      `[agent] sync automático do carrinho falhou após ${call.name}: ${reason}`,
    );
    ctx.recordValidatorHit(`sync:${reason}`);
    return `Sistema: não consegui sincronizar este carrinho com o pedido em grupo automaticamente (${reason}). Leia o carrinho com getCart e registre com group_sync_cart.`;
  }

  private async sync(
    call: ToolCall,
    cartId: string,
    ctx: TurnContext,
  ): Promise<string> {
    const fallback = (reason: string) => this.fallback(call, reason, ctx);
    const args = getCartArgs(ctx.session.tools, cartId);
    if (!args) return fallback(`${GET_CART} indisponível`);
    let cart: { text: string; isError: boolean };
    try {
      cart = await this.mcp.callTool(ctx.session, GET_CART, args);
    } catch (err) {
      return fallback(`${GET_CART} falhou: ${String(err).slice(0, 120)}`);
    }
    if (cart.isError) return fallback(`${GET_CART} devolveu erro`);
    const parsed = parseCart(cart.text, cartId);
    if (!parsed.ok) return fallback(parsed.reason);
    try {
      const result = await this.groupTools.syncIfoodCart(
        ctx.tool,
        parsed.input,
      );
      ctx.markCartChanged();
      const { subtotal, total, items } = parsed.input;
      return [
        `Sistema: carrinho sincronizado automaticamente com o pedido em grupo a partir do getCart (${items.length} item(ns), subtotal ${formatBRL(toCents(subtotal))}, total ${formatBRL(toCents(total))}). Não chame group_sync_cart.`,
        wrapToolResult('sincronizacao_do_carrinho', JSON.stringify(result)),
      ].join('\n');
    } catch (err) {
      if (err instanceof GroupOrderError) {
        this.logger.warn(
          `[agent] pedido em grupo recusou o sync do carrinho ${cartId}: ${err.message}`,
        );
        return `Sistema: o carrinho mudou no iFood, mas o pedido em grupo não aceitou a atualização: ${err.message}`;
      }
      return fallback('erro interno ao registrar');
    }
  }
}
