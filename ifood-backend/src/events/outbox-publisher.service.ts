import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import { describeError } from '../common/describe-error.js';
import { config } from '../config.js';
import { MockDbService } from '../db/mock-db.service.js';
import {
  PAYMENTS_BINDING_KEY,
  PAYMENTS_EXCHANGE,
  PAYMENTS_QUEUE,
} from './topology.js';

const BATCH = 50;
const IDLE_POLL_MS = 1000;
const MAX_BACKOFF_MS = 15_000;

interface OutboxRow {
  id: string;
  event_id: string;
  type: string;
  payload: unknown;
}

// Lê a tabela outbox e publica no RabbitMQ (at-least-once): a linha só é marcada como publicada
// depois da confirmação do broker. Se o RabbitMQ estiver fora, as linhas esperam e saem quando ele
// voltar. O consumidor é idempotente, então reenvios são seguros.
@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;
  private loopDone: Promise<void> = Promise.resolve();

  constructor(private readonly database: MockDbService) {}

  onModuleInit(): void {
    // Não bloqueia o boot: o mock sobe mesmo com o RabbitMQ fora.
    this.loopDone = this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loopDone;
    await this.dropConnection();
  }

  // Acorda o loop (ex.: logo depois de um pagamento) em vez de esperar o próximo ciclo.
  kick(): void {
    this.wake?.();
  }

  private async loop(): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        await this.database.ready();
        await this.ensureChannel();
        const published = await this.flushOnce();
        backoff = 1000;
        if (published === BATCH) continue; // pode haver mais linhas esperando
        await this.sleep(IDLE_POLL_MS);
      } catch (err) {
        if (this.stopped) break;
        this.logger.warn(
          `Não consegui publicar eventos (nova tentativa em ${backoff}ms): ${describeError(err)}`,
        );
        await this.dropConnection();
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private async ensureChannel(): Promise<void> {
    if (this.channel) return;

    const connection = await amqp.connect(config.rabbitUrl);
    // Sem listener de 'error', um erro de conexão derrubaria o processo.
    connection.on('error', (err: Error) =>
      this.logger.warn(`Conexão com o RabbitMQ: ${err.message}`),
    );
    connection.on('close', () => {
      if (this.connection === connection) {
        this.connection = null;
        this.channel = null;
      }
    });

    try {
      const channel = await connection.createConfirmChannel();
      channel.on('error', (err: Error) =>
        this.logger.warn(`Canal do RabbitMQ: ${err.message}`),
      );
      channel.on('close', () => {
        if (this.channel === channel) this.channel = null;
      });

      await channel.assertExchange(PAYMENTS_EXCHANGE, 'topic', {
        durable: true,
      });
      // Declarada aqui também: sem fila ligada, o exchange descartaria eventos publicados
      // antes de o consumidor subir. Mesmos argumentos do consumidor!
      await channel.assertQueue(PAYMENTS_QUEUE, { durable: true });
      await channel.bindQueue(
        PAYMENTS_QUEUE,
        PAYMENTS_EXCHANGE,
        PAYMENTS_BINDING_KEY,
      );

      this.connection = connection;
      this.channel = channel;
      this.logger.log(`Conectado ao RabbitMQ (exchange ${PAYMENTS_EXCHANGE})`);
    } catch (err) {
      await connection.close().catch(() => undefined);
      throw err;
    }
  }

  private async flushOnce(): Promise<number> {
    const channel = this.channel as ConfirmChannel;
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, event_id, type, payload
           FROM mock_ifood.outbox
          WHERE published_at IS NULL
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [BATCH],
      );
      if (rows.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      for (const row of rows) {
        channel.publish(
          PAYMENTS_EXCHANGE,
          row.type, // a routing key é o próprio tipo do evento (ex.: payment.confirmed)
          Buffer.from(JSON.stringify(row.payload)),
          {
            persistent: true,
            contentType: 'application/json',
            messageId: row.event_id,
            type: row.type,
            timestamp: Math.floor(Date.now() / 1000),
          },
        );
      }
      await channel.waitForConfirms();

      await client.query(
        'UPDATE mock_ifood.outbox SET published_at = now() WHERE id = ANY($1::bigint[])',
        [rows.map((r) => r.id)],
      );
      await client.query('COMMIT');
      this.logger.log(
        `Publicou ${rows.length} evento(s): ${rows.map((r) => r.type).join(', ')}`,
      );
      return rows.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async dropConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.channel = null;
    await connection?.close().catch(() => undefined);
  }

  // Dorme até `ms` ou até alguém chamar kick()/parar o serviço.
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}
