import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, asc, eq, ne } from 'drizzle-orm';
import { AuthService } from '../auth/auth.service.js';
import { DbService } from '../db/db.service.js';
import {
  cartItems,
  carts,
  orders,
  participants,
  payments,
  users,
} from '../db/schema.js';
import { toCents } from '../group-order/money.js';
import { McpService } from '../mcp/mcp.service.js';
import { matchItem, parseMcpCart, type McpCartInfo } from './mcp-cart.js';
import { PaymentProviderClient } from './payment-provider.client.js';
import { PaymentsService } from './payments.service.js';

const GET_CART_TOOL = 'getCart';

// Depois de emitir as cobranças, manda ao mock do iFood o pedido como o app mostra ao pagador:
// subpedidos (um por cobrança) com itens e preços do banco, enriquecidos com o getCart do MCP
// (loja, complementos, observação, prazo, endereço). Sem MCP (dono deslogado, MCP fora), vai só
// com o banco: o link continua funcionando.
@Injectable()
export class OrderSnapshotService implements OnModuleInit {
  private readonly logger = new Logger(OrderSnapshotService.name);

  constructor(
    private readonly database: DbService,
    private readonly payments: PaymentsService,
    private readonly provider: PaymentProviderClient,
    private readonly auth: AuthService,
    private readonly mcp: McpService,
  ) {}

  onModuleInit(): void {
    this.payments.onChargesIssued((orderId) => this.publish(orderId));
  }

  private get db() {
    return this.database.db;
  }

  async publish(orderId: number): Promise<void> {
    const rows = await this.db
      .select({
        paymentId: payments.id,
        cartId: payments.cartId,
        participantId: payments.participantId,
        participant: participants.name,
        restaurant: carts.restaurantName,
        ifoodCartId: carts.ifoodCartId,
      })
      .from(payments)
      .innerJoin(carts, eq(carts.id, payments.cartId))
      .innerJoin(participants, eq(participants.id, payments.participantId))
      .where(and(eq(carts.orderId, orderId), ne(payments.status, 'void')))
      .orderBy(asc(payments.id));
    if (rows.length === 0) return;

    const items = await this.db
      .select({
        id: cartItems.id,
        cartId: cartItems.cartId,
        payer: cartItems.payerParticipantId,
        ifoodItemId: cartItems.ifoodItemId,
        name: cartItems.name,
        unitPrice: cartItems.unitPrice,
        quantity: cartItems.quantity,
      })
      .from(cartItems)
      .innerJoin(carts, eq(carts.id, cartItems.cartId))
      .where(eq(carts.orderId, orderId))
      .orderBy(asc(cartItems.id));

    const mcpCarts = await this.loadMcpCarts(orderId, [
      ...new Set(rows.map((r) => r.ifoodCartId)),
    ]);
    const address =
      [...mcpCarts.values()].find((c) => c.address)?.address ?? null;

    await this.provider.publishOrder(String(orderId), {
      label: `#${orderId}`,
      address,
      subOrders: rows.map((p) => {
        const cart = mcpCarts.get(p.ifoodCartId);
        return {
          chargeReference: String(p.paymentId),
          participant: p.participant,
          restaurant: {
            name: p.restaurant ?? cart?.merchantName ?? 'Restaurante',
          },
          eta: cart?.eta ?? null,
          items: items
            .filter(
              (i) => i.cartId === p.cartId && i.payer === p.participantId,
            )
            .map((i) => {
              const extra = cart ? matchItem(cart, i.ifoodItemId) : null;
              return {
                id: String(i.id),
                name: i.name,
                description: extra?.customerNote ?? null,
                quantity: i.quantity,
                unitPriceCents: toCents(i.unitPrice),
                options: extra?.options ?? [],
              };
            }),
        };
      }),
    });
    this.logger.log(
      `[snapshot] pedido ${orderId} enviado ao iFood (${rows.length} subpedido(s), ${mcpCarts.size} carrinho(s) do MCP)`,
    );
  }

  // getCart de cada carrinho com o token do dono do pedido. Falha = segue sem enriquecer.
  private async loadMcpCarts(
    orderId: number,
    ifoodCartIds: string[],
  ): Promise<Map<string, McpCartInfo>> {
    const result = new Map<string, McpCartInfo>();
    try {
      const [owner] = await this.db
        .select({ chatId: users.telegramChatId })
        .from(orders)
        .innerJoin(users, eq(users.id, orders.ownerUserId))
        .where(eq(orders.id, orderId));
      if (!owner?.chatId) return result;
      const token = await this.auth.getValidAccessToken(owner.chatId);
      if (!token) return result;
      const session = await this.mcp.getSession(owner.chatId, token);
      if (!session.tools.some((t) => t.name === GET_CART_TOOL)) return result;

      await Promise.all(
        ifoodCartIds.map(async (cartId) => {
          try {
            const output = await this.mcp.callTool(session, GET_CART_TOOL, {
              cartId,
            });
            const info = output.isError ? null : parseMcpCart(output.text);
            if (info) result.set(cartId, info);
          } catch (err) {
            this.logger.warn(
              `[snapshot] getCart ${cartId} falhou: ${String(err)}`,
            );
          }
        }),
      );
    } catch (err) {
      this.logger.warn(
        `[snapshot] sem dados do MCP para o pedido ${orderId}: ${String(err)}`,
      );
    }
    return result;
  }
}
