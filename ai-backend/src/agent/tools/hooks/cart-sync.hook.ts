import type { Logger } from '@nestjs/common';
import { GroupOrderError } from '../../../group-order/group-order.errors.js';
import type { GroupOrderTools } from '../../../group-order/group-order.tools.js';
import { formatBRL, toCents } from '../../../group-order/money.js';
import type { McpService } from '../../../mcp/mcp.service.js';
import { cartIdOf, GET_CART, getCartArgs, parseCart } from '../../cart-sync.js';
import { wrapToolResult } from '../../tool-envelope.js';
import type { TurnContext } from '../../turn/turn-context.js';
import type { ToolCall } from '../tool-handler.js';

// Sync automático (ver cart-sync.ts): depois de uma escrita bem-sucedida num carrinho do iFood, lê
// o carrinho com getCart e registra no pedido em grupo. Devolve a nota que o LLM lê junto com o
// resultado da alteração; em qualquer falha, a nota manda usar group_sync_cart (caminho manual).
export class CartSyncHook {
  constructor(
    private readonly mcp: McpService,
    private readonly groupTools: GroupOrderTools,
    private readonly logger: Logger,
  ) {}

  async afterWrite(
    call: ToolCall,
    output: string,
    ctx: TurnContext,
  ): Promise<string> {
    const fallback = (reason: string) => {
      this.logger.warn(
        `[agent] sync automático do carrinho falhou após ${call.name}: ${reason}`,
      );
      ctx.recordValidatorHit(`sync:${reason}`);
      return `Sistema: não consegui sincronizar este carrinho com o pedido em grupo automaticamente (${reason}). Leia o carrinho com getCart e registre com group_sync_cart.`;
    };
    const cartId = cartIdOf(call.input, output);
    if (!cartId) return fallback('cartId não identificado');
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
