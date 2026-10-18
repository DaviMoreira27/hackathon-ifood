import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { MockDbService } from '../db/mock-db.service.js';
import {
  PAYMENT_CONFIRMED,
  type PaymentConfirmedEvent,
} from '../events/topology.js';
import { OutboxPublisher } from '../events/outbox-publisher.service.js';
import { deriveToken, hashToken } from './token.js';

interface ChargeRow {
  id: string;
  reference: string;
  amount_cents: number;
  description: string;
  status: 'pending' | 'paid' | 'cancelled';
  expires_at: Date;
  paid_at: Date | null;
}

export type ChargeStatus = 'pending' | 'paid' | 'cancelled' | 'expired';

export interface ChargeView {
  id: string;
  description: string;
  amountCents: number;
  status: ChargeStatus;
  expiresAt: string;
  paidAt: string | null;
}

export interface CreateChargeInput {
  reference: string;
  amountCents: number;
  description?: string;
  expiresInMinutes?: number;
}

const MAX_AMOUNT_CENTS = 10_000_000;
const DEFAULT_TTL_MINUTES = 24 * 60;
const MAX_TTL_MINUTES = 7 * 24 * 60;

const effectiveStatus = (row: ChargeRow): ChargeStatus =>
  row.status === 'pending' && row.expires_at.getTime() <= Date.now()
    ? 'expired'
    : row.status;

const toView = (row: ChargeRow): ChargeView => ({
  id: row.id,
  description: row.description,
  amountCents: row.amount_cents,
  status: effectiveStatus(row),
  expiresAt: row.expires_at.toISOString(),
  paidAt: row.paid_at ? row.paid_at.toISOString() : null,
});

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly database: MockDbService,
    private readonly outbox: OutboxPublisher,
  ) {}

  private get pool() {
    return this.database.pool;
  }

  // Idempotente por `reference`: repetir a chamada devolve a mesma cobrança e o mesmo token.
  async createCharge(
    input: CreateChargeInput,
  ): Promise<{ charge: ChargeView; token: string; created: boolean }> {
    const { reference, amountCents } = input;
    if (
      typeof reference !== 'string' ||
      !reference.trim() ||
      reference.length > 100
    ) {
      throw new BadRequestException(
        'reference é obrigatório (até 100 caracteres)',
      );
    }
    if (
      !Number.isInteger(amountCents) ||
      amountCents <= 0 ||
      amountCents > MAX_AMOUNT_CENTS
    ) {
      throw new BadRequestException(
        'amountCents deve ser um inteiro positivo (centavos)',
      );
    }
    const ttl = input.expiresInMinutes ?? DEFAULT_TTL_MINUTES;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_MINUTES) {
      throw new BadRequestException(
        `expiresInMinutes deve estar entre 1 e ${MAX_TTL_MINUTES}`,
      );
    }
    const description = String(input.description ?? '').slice(0, 300);

    const token = deriveToken(config.tokenSecret, reference);
    const inserted = await this.pool.query<ChargeRow>(
      `INSERT INTO mock_ifood.charges (reference, amount_cents, description, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))
       ON CONFLICT (reference) DO NOTHING
       RETURNING *`,
      [reference, amountCents, description, hashToken(token), ttl],
    );
    if (inserted.rows[0]) {
      this.logger.log(
        `[charge] criada reference=${reference} valor=${amountCents}c`,
      );
      return { charge: toView(inserted.rows[0]), token, created: true };
    }

    const existing = await this.pool.query<ChargeRow>(
      'SELECT * FROM mock_ifood.charges WHERE reference = $1',
      [reference],
    );
    const row = existing.rows[0];
    if (row.amount_cents !== amountCents) {
      throw new ConflictException(
        `reference ${reference} já existe com outro valor (${row.amount_cents}c)`,
      );
    }
    return { charge: toView(row), token, created: false };
  }

  async getByToken(token: string): Promise<ChargeView> {
    const { rows } = await this.pool.query<ChargeRow>(
      'SELECT * FROM mock_ifood.charges WHERE token_hash = $1',
      [hashToken(token)],
    );
    if (!rows[0]) throw new NotFoundException('Cobrança não encontrada');
    return toView(rows[0]);
  }

  // O primeiro pagamento vence: o UPDATE condicional é atômico, então dois cliques (ou duas
  // pessoas com o mesmo link) nunca geram dois eventos.
  async payByToken(token: string): Promise<ChargeView> {
    const tokenHash = hashToken(token);
    const client = await this.pool.connect();
    let paid: ChargeRow | undefined;
    try {
      await client.query('BEGIN');
      const updated = await client.query<ChargeRow>(
        `UPDATE mock_ifood.charges
            SET status = 'paid', paid_at = now()
          WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()
          RETURNING *`,
        [tokenHash],
      );
      paid = updated.rows[0];
      if (paid) {
        const paidAt = (paid.paid_at as Date).toISOString();
        const event: PaymentConfirmedEvent = {
          eventId: randomUUID(),
          type: PAYMENT_CONFIRMED,
          version: 1,
          occurredAt: paidAt,
          data: {
            paymentId: paid.id,
            reference: paid.reference,
            amountCents: paid.amount_cents,
            paidAt,
          },
        };
        await client.query(
          'INSERT INTO mock_ifood.outbox (event_id, type, payload) VALUES ($1, $2, $3)',
          [event.eventId, event.type, JSON.stringify(event)],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    if (paid) {
      this.logger.log(
        `[charge] paga reference=${paid.reference} valor=${paid.amount_cents}c`,
      );
      this.outbox.kick();
      return toView(paid);
    }

    const current = await this.getByToken(token); // 404 se o token não existe
    throw new ConflictException({
      message: `Cobrança não pode ser paga (${current.status})`,
      status: current.status,
    });
  }

  // Idempotente. Só falha se a cobrança já foi paga (aí o ai-backend não pode anulá-la).
  async cancel(reference: string): Promise<ChargeView> {
    if (typeof reference !== 'string' || !reference.trim()) {
      throw new BadRequestException('reference é obrigatório');
    }
    const updated = await this.pool.query<ChargeRow>(
      `UPDATE mock_ifood.charges SET status = 'cancelled'
        WHERE reference = $1 AND status = 'pending' RETURNING *`,
      [reference],
    );
    if (updated.rows[0]) {
      this.logger.log(`[charge] cancelada reference=${reference}`);
      return toView(updated.rows[0]);
    }

    const { rows } = await this.pool.query<ChargeRow>(
      'SELECT * FROM mock_ifood.charges WHERE reference = $1',
      [reference],
    );
    if (!rows[0]) throw new NotFoundException('Cobrança não encontrada');
    if (rows[0].status === 'paid') {
      throw new ConflictException({
        message: 'Cobrança já foi paga e não pode ser cancelada',
        status: 'paid',
      });
    }
    return toView(rows[0]);
  }
}
