import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { cartItems, payments } from '../db/schema.js';
import { PaymentsService } from '../payments/payments.service.js';
import { GroupOrderError } from './group-order.errors.js';
import type { PaymentLink } from './group-order.types.js';
import { formatBRL, toCents } from './money.js';
import { loadPayments } from './order.lookups.js';

interface PendingCharge {
  id: number;
  participantName: string;
  externalPaymentId: string | null;
}

// Cobranças do pedido em grupo junto ao provedor de pagamento: gerar os links, cancelar os
// pendentes e reemitir os que morreram num cancelamento interrompido.
@Injectable()
export class ChargesService {
  private readonly logger = new Logger(ChargesService.name);

  constructor(
    private readonly database: DbService,
    private readonly payments: PaymentsService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // Pede ao provedor os links das cobranças pendentes que ainda não têm. Devolve os nomes de quem
  // ficou sem link (provedor fora do ar etc.); o pedido continua válido e dá para tentar de novo.
  async ensureCharges(orderId: number): Promise<string[]> {
    const failed: string[] = [];
    const rows = await loadPayments(this.db, orderId);
    for (const p of rows.filter((r) => r.status === 'pending' && !r.payUrl)) {
      try {
        const items = await this.db
          .select({ name: cartItems.name, quantity: cartItems.quantity })
          .from(cartItems)
          .where(
            and(
              eq(cartItems.cartId, p.cartId),
              eq(cartItems.payerParticipantId, p.participantId),
            ),
          )
          .orderBy(asc(cartItems.id));
        const description =
          `${p.restaurantName ?? 'iFood'} — ${p.participantName}: ${items
            .map((i) => `${i.quantity}x ${i.name}`)
            .join(', ')}`.slice(0, 280);
        await this.payments.issueCharge({
          id: p.id,
          amountCents: toCents(p.amount),
          description,
        });
      } catch (err) {
        this.logger.error(
          `[group] falha ao gerar link do pagamento ${p.id}: ${String(err)}`,
        );
        failed.push(p.participantName);
      }
    }
    await this.payments.chargesIssued(orderId);
    return failed;
  }

  async pendingLinks(orderId: number): Promise<PaymentLink[]> {
    return (await loadPayments(this.db, orderId))
      .filter((p) => p.status === 'pending' && p.payUrl)
      .map((p) => ({
        participant: p.participantName,
        restaurant: p.restaurantName ?? p.ifoodCartId,
        amount: formatBRL(toCents(p.amount)),
        url: p.payUrl as string,
      }));
  }

  // Cancela os links no provedor (fora de transação: é uma chamada de rede). O cancelamento é
  // condicional lá: se alguém pagou nesse meio tempo, o provedor recusa (409) e abortamos.
  async cancelPending(
    orderId: number,
    pending: PendingCharge[],
    verb: string,
  ): Promise<void> {
    const cancelled: PendingCharge[] = [];
    try {
      for (const p of pending) {
        if (!p.externalPaymentId) continue; // o link nunca chegou a existir
        let result;
        try {
          result = await this.payments.cancelCharge(p.id);
        } catch (err) {
          this.logger.error(
            `[group] falha ao cancelar a cobrança ${p.id}: ${String(err)}`,
          );
          throw new GroupOrderError(
            'Não consegui cancelar os links de pagamento agora (provedor indisponível). Tente de novo em instantes.',
          );
        }
        if (result === 'paid') {
          throw new GroupOrderError(
            `${p.participantName} acabou de pagar: não dá mais para ${verb} o pedido. Use group_get_order para ver o estado.`,
          );
        }
        cancelled.push(p);
      }
    } catch (err) {
      await this.reissue(orderId, cancelled);
      throw err;
    }
  }

  // Se o cancelamento foi interrompido no meio, os links já cancelados no provedor estão mortos
  // mas continuam "pendentes" aqui. Troca cada um por uma cobrança nova (mesmo valor, novo link).
  private async reissue(
    orderId: number,
    dead: Array<{ id: number }>,
  ): Promise<void> {
    if (dead.length === 0) return;
    try {
      await this.db.transaction(async (tx) => {
        for (const { id } of dead) {
          const [old] = await tx
            .select()
            .from(payments)
            .where(eq(payments.id, id));
          await tx
            .update(payments)
            .set({ status: 'void' })
            .where(eq(payments.id, id));
          await tx.insert(payments).values({
            cartId: old.cartId,
            participantId: old.participantId,
            amount: old.amount,
          });
        }
      });
      await this.ensureCharges(orderId);
    } catch (err) {
      this.logger.error(
        `[group] falha ao reemitir links do pedido ${orderId}: ${String(err)}`,
      );
    }
  }
}
