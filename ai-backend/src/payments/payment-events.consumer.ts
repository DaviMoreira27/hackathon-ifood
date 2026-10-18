import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import amqp, {
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
} from 'amqplib';
import { describeError } from '../common/describe-error.js';
import {
  PaymentsService,
  UnrecoverableEventError,
} from './payments.service.js';
import {
  PAYMENT_CONFIRMED,
  PAYMENTS_BINDING_KEY,
  PAYMENTS_DLQ,
  PAYMENTS_EXCHANGE,
  PAYMENTS_QUEUE,
  PAYMENTS_RETRY_QUEUE,
  type PaymentConfirmedEvent,
} from './topology.js';

export interface PaymentEventsConsumerOptions {
  url: string;
  queue: string;
  retryQueue: string;
  dlq: string;
  // Quanto uma mensagem espera na fila de retry antes de voltar para a principal.
  retryDelayMs: number;
  // Total de tentativas (a primeira + os retries) antes de ir para a DLQ.
  maxAttempts: number;
  prefetch: number;
}

export const PAYMENT_EVENTS_OPTIONS = Symbol('PAYMENT_EVENTS_OPTIONS');

export function defaultConsumerOptions(): PaymentEventsConsumerOptions {
  return {
    url: process.env.RABBITMQ_URL ?? 'amqp://ifood:ifood@localhost:5672',
    queue: PAYMENTS_QUEUE,
    retryQueue: PAYMENTS_RETRY_QUEUE,
    dlq: PAYMENTS_DLQ,
    retryDelayMs: 5000,
    maxAttempts: 5,
    prefetch: 10,
  };
}

// Mensagem malformada ou de versão desconhecida: não adianta tentar de novo.
class InvalidEventError extends Error {}

export function parseEvent(
  content: Buffer,
): PaymentConfirmedEvent | { ignored: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString('utf8'));
  } catch {
    throw new InvalidEventError('JSON inválido');
  }
  const event = raw as Partial<PaymentConfirmedEvent> | null;
  if (
    !event ||
    typeof event !== 'object' ||
    typeof event.eventId !== 'string' ||
    !event.eventId
  ) {
    throw new InvalidEventError('eventId ausente');
  }
  if (event.type !== PAYMENT_CONFIRMED) {
    // Outros eventos "payment.*" que venham a existir: não é erro, só não é com a gente.
    return { ignored: String(event.type) };
  }
  if (event.version !== 1) {
    throw new InvalidEventError(
      `versão não suportada: ${String(event.version)}`,
    );
  }
  const data = event.data;
  if (
    !data ||
    typeof data.reference !== 'string' ||
    !Number.isInteger(data.amountCents) ||
    (data.amountCents as number) <= 0 ||
    typeof data.paidAt !== 'string' ||
    Number.isNaN(Date.parse(data.paidAt))
  ) {
    throw new InvalidEventError('campos de data inválidos');
  }
  return event as PaymentConfirmedEvent;
}

// Consome `payment.confirmed` do RabbitMQ.
//  - ack só depois de aplicar no banco (at-least-once; a aplicação é idempotente);
//  - falha transitória → fila de retry (espera retryDelayMs) até maxAttempts, depois DLQ;
//  - falha definitiva (evento inválido/inconsistente) → DLQ direto;
//  - reconecta sozinho se o RabbitMQ cair; o app sobe mesmo com o RabbitMQ fora.
@Injectable()
export class PaymentEventsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentEventsConsumer.name);
  private readonly options: PaymentEventsConsumerOptions;
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;
  private loopDone: Promise<void> = Promise.resolve();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly payments: PaymentsService,
    @Optional() options?: PaymentEventsConsumerOptions,
  ) {
    this.options = options ?? defaultConsumerOptions();
  }

  get consuming(): boolean {
    return this.channel !== null;
  }

  onModuleInit(): void {
    this.loopDone = this.run(); // não bloqueia o boot
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    // Deixa terminar o que já está sendo processado; o resto fica na fila (não recebe ack).
    const channel = this.channel;
    this.channel = null;
    await channel?.close().catch(() => undefined);
    await Promise.race([
      Promise.allSettled(this.inFlight),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    await this.connection?.close().catch(() => undefined);
    this.connection = null;
    await this.loopDone;
  }

  private async run(): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        const { closed } = await this.connect();
        backoff = 1000;
        await closed; // fica aqui enquanto a conexão estiver de pé
        if (!this.stopped)
          this.logger.warn('Conexão com o RabbitMQ caiu; reconectando...');
      } catch (err) {
        if (this.stopped) break;
        this.logger.warn(
          `Consumidor sem conexão com o RabbitMQ (nova tentativa em ${backoff}ms): ${describeError(err)}`,
        );
        await this.cleanup();
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 15_000);
        continue;
      }
      await this.cleanup();
      if (!this.stopped) await this.sleep(1000);
    }
  }

  // Conecta, declara a topologia e começa a consumir. `closed` resolve quando a conexão fechar
  // (num objeto: devolver a promise direto faria o await esperar a conexão cair).
  private async connect(): Promise<{ closed: Promise<void> }> {
    const { url, queue, retryQueue, dlq, retryDelayMs, prefetch } =
      this.options;
    const connection = await amqp.connect(url);
    // Sem listener de 'error', um erro de conexão derrubaria o processo.
    connection.on('error', (err: Error) =>
      this.logger.warn(`Conexão com o RabbitMQ: ${err.message}`),
    );
    const closed = new Promise<void>((resolve) =>
      connection.once('close', () => resolve()),
    );

    try {
      const channel = await connection.createConfirmChannel();
      channel.on('error', (err: Error) =>
        this.logger.warn(`Canal do RabbitMQ: ${err.message}`),
      );

      await channel.assertExchange(PAYMENTS_EXCHANGE, 'topic', {
        durable: true,
      });
      await channel.assertQueue(queue, { durable: true });
      await channel.bindQueue(queue, PAYMENTS_EXCHANGE, PAYMENTS_BINDING_KEY);
      await channel.assertQueue(dlq, { durable: true });
      // Retry: a mensagem espera o TTL e é "dead-lettered" para o exchange padrão ('') com a
      // routing key = fila principal, ou seja, volta direto para ela.
      await channel.assertQueue(retryQueue, {
        durable: true,
        arguments: {
          'x-message-ttl': retryDelayMs,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': queue,
        },
      });
      await channel.prefetch(prefetch);
      await channel.consume(queue, (message) => {
        if (message) this.track(this.handle(channel, message));
      });

      this.connection = connection;
      this.channel = channel;
      this.logger.log(`Consumindo eventos de pagamento da fila ${queue}`);
      return { closed };
    } catch (err) {
      await connection.close().catch(() => undefined);
      throw err;
    }
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  // Exposto para testes.
  async handle(
    channel: ConfirmChannel,
    message: ConsumeMessage,
  ): Promise<void> {
    try {
      const parsed = parseEvent(message.content);
      if ('ignored' in parsed) {
        this.logger.warn(`Evento de tipo ${parsed.ignored} ignorado`);
      } else {
        await this.payments.applyConfirmedEvent(parsed);
      }
      channel.ack(message);
    } catch (err) {
      await this.fail(channel, message, err);
    }
  }

  private async fail(
    channel: ConfirmChannel,
    message: ConsumeMessage,
    err: unknown,
  ): Promise<void> {
    const { retryQueue, dlq, maxAttempts } = this.options;
    const attempt = Number(message.properties.headers?.['x-attempt'] ?? 0) + 1;
    const definitive =
      err instanceof UnrecoverableEventError ||
      err instanceof InvalidEventError;
    const exhausted = attempt >= maxAttempts;
    const toDlq = definitive || exhausted;
    const reason = describeError(err);

    this.logger[toDlq ? 'error' : 'warn'](
      toDlq
        ? `Evento ${message.properties.messageId ?? '?'} vai para a DLQ (${definitive ? 'definitivo' : `esgotou ${maxAttempts} tentativas`}): ${reason}`
        : `Falha ao aplicar o evento ${message.properties.messageId ?? '?'} (tentativa ${attempt}/${maxAttempts}): ${reason}`,
    );

    try {
      // Publica primeiro e só então dá ack: se o processo morrer no meio, a mensagem original
      // volta (duplicada, e o consumidor é idempotente) em vez de se perder.
      channel.sendToQueue(toDlq ? dlq : retryQueue, message.content, {
        persistent: true,
        contentType: message.properties.contentType,
        messageId: message.properties.messageId,
        type: message.properties.type,
        headers: {
          ...message.properties.headers,
          'x-attempt': attempt,
          ...(toDlq ? { 'x-error': reason.slice(0, 500) } : {}),
        },
      });
      await channel.waitForConfirms();
      channel.ack(message);
    } catch (publishErr) {
      this.logger.error(
        `Não consegui redirecionar o evento (ficará sem ack): ${describeError(publishErr)}`,
      );
    }
  }

  private async cleanup(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.channel = null;
    await connection?.close().catch(() => undefined);
  }

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
