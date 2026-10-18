import { Injectable, Logger } from '@nestjs/common';
import { and, count, eq, ne } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import {
  carts,
  orders,
  participants,
  payments,
  processedEvents,
  users,
} from '../db/schema.js';
import { toCents } from '../group-order/money.js';
import {
  PaymentProviderClient,
  type CancelResult,
} from './payment-provider.client.js';
import type { PaymentConfirmedEvent } from './topology.js';

// O evento não pode ser aplicado nunca (dado inconsistente): vai para a DLQ em vez de ser repetido.
export class UnrecoverableEventError extends Error {}

export interface PaymentApplied {
  paymentId: number;
  orderId: number;
  participantName: string;
  restaurantName: string | null;
  amountCents: number;
  cartPaid: boolean;
  orderPaid: boolean;
  pendingParticipants: string[];
  // Chat do dono do pedido, para avisar no Telegram (nulo se o dono não veio do Telegram).
  ownerChatId: number | null;
}

type Listener = (applied: PaymentApplied) => void | Promise<void>;
type IssuedListener = (orderId: number) => Promise<void>;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly listeners: Listener[] = [];
  private readonly issuedListeners: IssuedListener[] = [];

  constructor(
    private readonly database: DbService,
    private readonly provider: PaymentProviderClient,
  ) {}

  private get db() {
    return this.database.db;
  }

  onPaymentApplied(listener: Listener): void {
    this.listeners.push(listener);
  }

  onChargesIssued(listener: IssuedListener): void {
    this.issuedListeners.push(listener);
  }

  // Chamado depois de emitir/reemitir as cobranças de um pedido (ex.: publicar o pedido no
  // provedor). Falha aqui não invalida as cobranças: só é registrada.
  async chargesIssued(orderId: number): Promise<void> {
    for (const listener of this.issuedListeners) {
      try {
        await listener(orderId);
      } catch (err) {
        this.logger.error(
          `Falha pós-emissão das cobranças do pedido ${orderId}: ${String(err)}`,
        );
      }
    }
  }

  // Pede a cobrança ao provedor e guarda o link. Idempotente (a referência é o id do pagamento).
  async issueCharge(payment: {
    id: number;
    amountCents: number;
    description: string;
  }): Promise<string> {
    const ttl = Number(process.env.PAYMENT_TTL_MINUTES ?? 24 * 60);
    const charge = await this.provider.createCharge({
      reference: String(payment.id),
      amountCents: payment.amountCents,
      description: payment.description,
      expiresInMinutes: Number.isInteger(ttl) && ttl > 0 ? ttl : 24 * 60,
    });
    const payUrl = this.buildPayUrl(charge.token);
    await this.db
      .update(payments)
      .set({
        externalPaymentId: charge.id,
        payUrl,
        expiresAt: new Date(charge.expiresAt),
      })
      .where(eq(payments.id, payment.id));
    return payUrl;
  }

  cancelCharge(paymentId: number): Promise<CancelResult> {
    return this.provider.cancelCharge(String(paymentId));
  }

  // O link aponta para o front (que roda no mesmo computador): ex.: http://localhost:5173/pay/{token}
  buildPayUrl(token: string): string {
    const template =
      process.env.PAYMENT_LINK_TEMPLATE ?? 'http://localhost:5173/pay/{token}';
    if (!template.includes('{token}')) {
      throw new Error('PAYMENT_LINK_TEMPLATE precisa conter {token}');
    }
    return template.replace('{token}', encodeURIComponent(token));
  }

  // Aplica `payment.confirmed`. Idempotente e seguro com eventos simultâneos do mesmo pedido:
  //  1. processed_events deduplica por eventId (entrega "pelo menos uma vez");
  //  2. a linha do pedido é travada (FOR UPDATE), então dois eventos do mesmo pedido são
  //     serializados e só um deles vê "todos pagaram";
  //  3. tudo (pagamento, carrinho, pedido) muda na mesma transação.
  // Devolve null quando não há nada a fazer (evento repetido / pagamento já pago).
  async applyConfirmedEvent(
    event: PaymentConfirmedEvent,
  ): Promise<PaymentApplied | null> {
    const applied = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(processedEvents)
        .values({ eventId: event.eventId, type: event.type })
        .onConflictDoNothing()
        .returning({ eventId: processedEvents.eventId });
      if (inserted.length === 0) {
        this.logger.log(`[evento] ${event.eventId} já processado — ignorando`);
        return null;
      }

      const paymentId = Number(event.data.reference);
      if (!Number.isSafeInteger(paymentId) || paymentId <= 0) {
        throw new UnrecoverableEventError(
          `reference inválida: ${event.data.reference}`,
        );
      }

      const [found] = await tx
        .select({ orderId: carts.orderId })
        .from(payments)
        .innerJoin(carts, eq(carts.id, payments.cartId))
        .where(eq(payments.id, paymentId));
      if (!found) {
        throw new UnrecoverableEventError(`pagamento ${paymentId} não existe`);
      }

      // Trava o pedido e só então relê tudo: o que valia antes do lock pode ter mudado.
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, found.orderId))
        .for('update');
      const [payment] = await tx
        .select()
        .from(payments)
        .where(eq(payments.id, paymentId));

      if (payment.status === 'paid') {
        this.logger.log(
          `[evento] pagamento ${paymentId} já estava pago — ignorando`,
        );
        return null;
      }
      if (payment.status === 'void') {
        throw new UnrecoverableEventError(
          `pagamento ${paymentId} foi anulado mas o provedor registrou um pagamento (reembolso manual?)`,
        );
      }
      if (order.status !== 'paying') {
        throw new UnrecoverableEventError(
          `pedido ${order.id} está '${order.status}', não 'paying'`,
        );
      }
      if (toCents(payment.amount) !== event.data.amountCents) {
        throw new UnrecoverableEventError(
          `valor divergente no pagamento ${paymentId}: esperado ${toCents(payment.amount)}c, recebido ${event.data.amountCents}c`,
        );
      }

      await tx
        .update(payments)
        .set({ status: 'paid', paidAt: new Date(event.data.paidAt) })
        .where(eq(payments.id, paymentId));

      const [{ pendingInCart }] = await tx
        .select({ pendingInCart: count() })
        .from(payments)
        .where(
          and(
            eq(payments.cartId, payment.cartId),
            eq(payments.status, 'pending'),
          ),
        );
      const cartPaid = pendingInCart === 0;

      let orderPaid = false;
      if (cartPaid) {
        await tx
          .update(carts)
          .set({ status: 'paid' })
          .where(eq(carts.id, payment.cartId));
        const [{ unpaidCarts }] = await tx
          .select({ unpaidCarts: count() })
          .from(carts)
          .where(and(eq(carts.orderId, order.id), ne(carts.status, 'paid')));
        orderPaid = unpaidCarts === 0;
        if (orderPaid) {
          await tx
            .update(orders)
            .set({ status: 'paid' })
            .where(eq(orders.id, order.id));
        }
      }

      const [who] = await tx
        .select({ name: participants.name, restaurant: carts.restaurantName })
        .from(participants)
        .innerJoin(carts, eq(carts.id, payment.cartId))
        .where(eq(participants.id, payment.participantId));
      const pending = await tx
        .select({ name: participants.name })
        .from(payments)
        .innerJoin(carts, eq(carts.id, payments.cartId))
        .innerJoin(participants, eq(participants.id, payments.participantId))
        .where(
          and(eq(carts.orderId, order.id), eq(payments.status, 'pending')),
        );
      const [owner] = await tx
        .select({ chatId: users.telegramChatId })
        .from(users)
        .where(eq(users.id, order.ownerUserId));

      return {
        paymentId,
        orderId: order.id,
        participantName: who.name,
        restaurantName: who.restaurant,
        amountCents: event.data.amountCents,
        cartPaid,
        orderPaid,
        pendingParticipants: pending.map((p) => p.name),
        ownerChatId: owner?.chatId ?? null,
      } satisfies PaymentApplied;
    });

    if (applied) {
      this.logger.log(
        `[evento] pagamento ${applied.paymentId} (${applied.participantName}) aplicado` +
          `${applied.cartPaid ? ', carrinho pago' : ''}${applied.orderPaid ? ', PEDIDO PAGO' : ''}`,
      );
      // Depois do commit: uma falha ao avisar o Telegram não desfaz o pagamento.
      for (const listener of this.listeners) {
        try {
          await listener(applied);
        } catch (err) {
          this.logger.error(
            `Falha ao notificar o pagamento ${applied.paymentId}: ${String(err)}`,
          );
        }
      }
    }
    return applied;
  }
}
