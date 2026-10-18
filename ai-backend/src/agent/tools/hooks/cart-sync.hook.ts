import type { Logger } from '@nestjs/common';
import {
  GroupOrderError,
  type GroupOrderTools,
  formatBRL,
  toCents,
} from '../../../group-order/index.js';
import type { McpService } from '../../../mcp/mcp.service.js';
import { parseCart, parseJson } from '../../cart-parser.js';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { isObj } from '../../../common/json.js';
import { appConfig } from '../../../config/app-config.js';
import { wrapToolResult } from '../../tool-envelope.js';
import type { TurnContext } from '../../turn/turn-context.js';
import type { ToolCall } from '../tool-handler.js';

// Sync automático do carrinho: depois de cada alteração bem-sucedida num carrinho do iFood, o
// código lê o carrinho (getCart) e registra no pedido em grupo os itens, preços, subtotal e total
// exatamente como o iFood devolveu. O LLM nunca transcreve número que vira cobrança. O resultado
// do getCart é lido por cart-parser.ts; se algo não fecha, o LLM é mandado usar group_sync_cart.

export const GET_CART = 'getCart';

// MCP_CART_SYNC_TOOLS (nomes separados por vírgula) substitui a lista padrão.
export function triggersCartSync(
  name: string,
  tools: string[] = appConfig().mcp.cartSyncTools,
): boolean {
  return tools.includes(name);
}

const CART_ID_KEYS = ['cartId', 'cart_id', 'ifoodCartId'];

function findCartId(value: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findCartId(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isObj(value)) return null;
  for (const key of CART_ID_KEYS) {
    const v = value[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  if (isObj(value.cart) && typeof value.cart.id === 'string') {
    return value.cart.id;
  }
  for (const v of Object.values(value)) {
    const found = findCartId(v, depth + 1);
    if (found) return found;
  }
  return null;
}

// O carrinho alterado: primeiro o argumento da chamada, depois o resultado da ferramenta.
export function cartIdOf(input: unknown, output: string): string | null {
  return findCartId(input) ?? findCartId(parseJson(output));
}

// Argumentos do getCart a partir do schema anunciado pelo MCP. null = não dá para saber.
export function getCartArgs(
  tools: Tool[],
  cartId: string,
): Record<string, string> | null {
  const tool = tools.find((t) => t.name === GET_CART);
  if (!tool) return null;
  const schema = tool.input_schema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const props = Object.keys(schema.properties ?? {});
  const key =
    CART_ID_KEYS.find((k) => props.includes(k)) ??
    (schema.required?.length === 1 ? schema.required[0] : undefined) ??
    (props.length === 1 ? props[0] : undefined);
  return key ? { [key]: cartId } : null;
}

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
