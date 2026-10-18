import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { describeError } from '../common/describe-error.js';
import {
  PaymentsService,
  UnrecoverableEventError,
} from './payments.service.js';
import {
  PAYMENTS_BINDING_KEY,
  PAYMENTS_DLQ,
  PAYMENTS_EXCHANGE,
  PAYMENTS_QUEUE,
  PAYMENTS_RETRY_QUEUE,
} from './topology.js';
import { appConfig } from '../config/app-config.js';
import { InvalidEventError, parseEvent } from './payment-event.parser.js';
import { RabbitConnection } from './rabbit-connection.js';

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
    url: appConfig().payments.rabbitmqUrl,
    queue: PAYMENTS_QUEUE,
    retryQueue: PAYMENTS_RETRY_QUEUE,
    dlq: PAYMENTS_DLQ,
    retryDelayMs: 5000,
    maxAttempts: 5,
    prefetch: 10,
  };
}

// Consome `payment.confirmed` do RabbitMQ.
//  - ack só depois de aplicar no banco (at-least-once; a aplicação é idempotente);
//  - falha transitória → fila de retry (espera retryDelayMs) até maxAttempts, depois DLQ;
//  - falha definitiva (evento inválido/inconsistente) → DLQ direto;
//  - reconecta sozinho se o RabbitMQ cair; o app sobe mesmo com o RabbitMQ fora (RabbitConnection).
@Injectable()
export class PaymentEventsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentEventsConsumer.name);
  private readonly options: PaymentEventsConsumerOptions;
  private readonly rabbit: RabbitConnection;

  constructor(
    private readonly payments: PaymentsService,
    @Optional() options?: PaymentEventsConsumerOptions,
  ) {
    this.options = options ?? defaultConsumerOptions();
    this.rabbit = new RabbitConnection(
      { url: this.options.url, setup: (channel) => this.setup(channel) },
      this.logger,
    );
  }

  get consuming(): boolean {
    return this.rabbit.channel !== null;
  }

  onModuleInit(): void {
    this.rabbit.start();
  }

  // Deixa terminar o que já está sendo processado; o resto fica na fila (não recebe ack).
  onModuleDestroy(): Promise<void> {
    return this.rabbit.stop();
  }

  // Topologia (exchange, fila principal, retry e DLQ) e consumo, a cada conexão.
  private async setup(channel: ConfirmChannel): Promise<void> {
    const { queue, retryQueue, dlq, retryDelayMs, prefetch } = this.options;
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
      if (message) this.rabbit.track(this.handle(channel, message));
    });
    this.logger.log(`Consumindo eventos de pagamento da fila ${queue}`);
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
}
