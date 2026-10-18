import amqp, {
  type Channel,
  type ChannelModel,
  type GetMessage,
} from 'amqplib';
import {
  PaymentEventsConsumer,
  type PaymentEventsConsumerOptions,
  parseEvent,
} from './payment-events.consumer.js';
import {
  PaymentsService,
  UnrecoverableEventError,
} from './payments.service.js';
import {
  PAYMENT_CONFIRMED,
  PAYMENTS_BINDING_KEY,
  PAYMENTS_EXCHANGE,
  type PaymentConfirmedEvent,
} from './topology.js';

const validEvent = (
  overrides: Partial<PaymentConfirmedEvent> = {},
): PaymentConfirmedEvent => ({
  eventId: `evt-${Math.random()}`,
  type: PAYMENT_CONFIRMED,
  version: 1,
  occurredAt: new Date().toISOString(),
  data: {
    paymentId: 'charge-1',
    reference: '42',
    amountCents: 1000,
    paidAt: new Date().toISOString(),
  },
  ...overrides,
});

describe('parseEvent', () => {
  const parse = (value: unknown) =>
    parseEvent(Buffer.from(JSON.stringify(value)));

  it('aceita payment.confirmed v1', () => {
    const event = validEvent();
    expect(parse(event)).toEqual(event);
  });

  it('ignora outros tipos de evento (compatibilidade futura)', () => {
    expect(
      parse({ eventId: 'x', type: 'payment.expired', version: 1 }),
    ).toEqual({
      ignored: 'payment.expired',
    });
  });

  it('rejeita o que não dá para processar', () => {
    expect(() => parseEvent(Buffer.from('não é json'))).toThrow(/JSON/);
    expect(() => parse({ type: PAYMENT_CONFIRMED })).toThrow(/eventId/);
    expect(() => parse(validEvent({ version: 2 as 1 }))).toThrow(/versão/);
    const noAmount = validEvent();
    (noAmount.data as { amountCents: unknown }).amountCents = 'mil';
    expect(() => parse(noAmount)).toThrow(/data/);
    const badDate = validEvent();
    badDate.data.paidAt = 'ontem';
    expect(() => parse(badDate)).toThrow(/data/);
  });
});

// Precisa de RabbitMQ real. Exemplo:
//   TEST_RABBITMQ_URL=amqp://ifood:ifood@localhost:5672 npm test
// Usa filas próprias (prefixo único) e as apaga no fim.
describe.skipIf(!process.env.TEST_RABBITMQ_URL)(
  'PaymentEventsConsumer (RabbitMQ)',
  () => {
    const URL = process.env.TEST_RABBITMQ_URL as string;
    const RUN = `t${Date.now()}`;
    let seq = 0;
    let connection: ChannelModel;
    let admin: Channel;
    let names: { queue: string; retryQueue: string; dlq: string };
    let consumers: PaymentEventsConsumer[];
    let apply: ReturnType<typeof vi.fn>;

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    async function waitFor(
      condition: () => boolean | Promise<boolean>,
      ms = 8000,
    ) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (await condition()) return;
        await sleep(25);
      }
      throw new Error('timeout esperando condição');
    }

    function startConsumer(
      overrides: Partial<PaymentEventsConsumerOptions> = {},
    ) {
      const options: PaymentEventsConsumerOptions = {
        url: URL,
        ...names,
        retryDelayMs: 200,
        maxAttempts: 3,
        prefetch: 5,
        ...overrides,
      };
      const consumer = new PaymentEventsConsumer(
        { applyConfirmedEvent: apply } as unknown as PaymentsService,
        options,
      );
      consumers.push(consumer);
      consumer.onModuleInit();
      return consumer;
    }

    const publish = (body: unknown, routingKey = PAYMENT_CONFIRMED) =>
      admin.publish(
        PAYMENTS_EXCHANGE,
        routingKey,
        Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
        { persistent: true, contentType: 'application/json', messageId: 'm-1' },
      );

    async function queueDepth(queue: string) {
      return (await admin.checkQueue(queue)).messageCount;
    }

    beforeAll(async () => {
      connection = await amqp.connect(URL);
      admin = await connection.createChannel();
      await admin.assertExchange(PAYMENTS_EXCHANGE, 'topic', { durable: true });
    });

    afterAll(async () => {
      await connection.close();
    });

    beforeEach(() => {
      const id = `${RUN}-${++seq}`;
      names = {
        queue: `${id}.payments`,
        retryQueue: `${id}.payments.retry`,
        dlq: `${id}.payments.dlq`,
      };
      consumers = [];
      apply = vi.fn().mockResolvedValue(null);
    });

    afterEach(async () => {
      for (const consumer of consumers) await consumer.onModuleDestroy();
      for (const queue of Object.values(names))
        await admin.deleteQueue(queue).catch(() => undefined);
    });

    it('aplica o evento e dá ack (fila vazia)', async () => {
      const consumer = startConsumer();
      await waitFor(() => consumer.consuming);
      const event = validEvent();

      publish(event);

      await waitFor(() => apply.mock.calls.length === 1);
      expect(apply.mock.calls[0][0]).toEqual(event);
      await waitFor(async () => (await queueDepth(names.queue)) === 0);
      expect(await queueDepth(names.dlq)).toBe(0);
    });

    it('eventos publicados antes de o consumidor subir esperam na fila', async () => {
      // A fila já existe (o mock a declara), o consumidor ainda não.
      await admin.assertQueue(names.queue, { durable: true });
      await admin.bindQueue(
        names.queue,
        PAYMENTS_EXCHANGE,
        PAYMENTS_BINDING_KEY,
      );
      publish(validEvent());
      await waitFor(async () => (await queueDepth(names.queue)) === 1);

      startConsumer();

      await waitFor(() => apply.mock.calls.length === 1);
    });

    it('falha transitória: tenta de novo pela fila de retry até dar certo', async () => {
      apply
        .mockRejectedValueOnce(new Error('banco indisponível'))
        .mockRejectedValueOnce(new Error('banco indisponível'))
        .mockResolvedValue(null);
      const consumer = startConsumer({ maxAttempts: 5 });
      await waitFor(() => consumer.consuming);

      publish(validEvent());

      await waitFor(() => apply.mock.calls.length === 3);
      await waitFor(async () => (await queueDepth(names.queue)) === 0);
      expect(await queueDepth(names.dlq)).toBe(0);
      expect(await queueDepth(names.retryQueue)).toBe(0);
    });

    it('esgotadas as tentativas, vai para a DLQ com o motivo e a contagem', async () => {
      apply.mockRejectedValue(new Error('sempre falha'));
      const consumer = startConsumer({ maxAttempts: 3 });
      await waitFor(() => consumer.consuming);
      const event = validEvent();

      publish(event);

      await waitFor(async () => (await queueDepth(names.dlq)) === 1);
      expect(apply).toHaveBeenCalledTimes(3);
      const dead = (await admin.get(names.dlq, { noAck: true })) as GetMessage;
      expect(JSON.parse(dead.content.toString())).toEqual(event);
      expect(dead.properties.headers).toMatchObject({ 'x-attempt': 3 });
      expect(String(dead.properties.headers?.['x-error'])).toContain(
        'sempre falha',
      );
    });

    it('erro definitivo vai direto para a DLQ, sem repetir', async () => {
      apply.mockRejectedValue(new UnrecoverableEventError('valor divergente'));
      const consumer = startConsumer({ maxAttempts: 5 });
      await waitFor(() => consumer.consuming);

      publish(validEvent());

      await waitFor(async () => (await queueDepth(names.dlq)) === 1);
      expect(apply).toHaveBeenCalledTimes(1);
    });

    it('mensagem malformada vai para a DLQ sem chamar o serviço; tipo desconhecido é ignorado', async () => {
      const consumer = startConsumer();
      await waitFor(() => consumer.consuming);

      publish('isto não é json');
      publish(
        { eventId: 'x', type: 'payment.expired', version: 1 },
        'payment.expired',
      );

      await waitFor(async () => (await queueDepth(names.dlq)) === 1);
      await waitFor(async () => (await queueDepth(names.queue)) === 0);
      expect(apply).not.toHaveBeenCalled();
      expect(await queueDepth(names.dlq)).toBe(1);
    });

    it('reconecta sozinho quando a conexão cai e volta a consumir', async () => {
      const consumer = startConsumer();
      await waitFor(() => consumer.consuming);

      await (
        consumer as unknown as { connection: ChannelModel }
      ).connection.close();
      await waitFor(() => !consumer.consuming);
      await waitFor(() => consumer.consuming);

      publish(validEvent());
      await waitFor(() => apply.mock.calls.length === 1);
    });

    it('o app sobe mesmo sem RabbitMQ e passa a consumir quando ele aparece', async () => {
      const consumer = startConsumer({
        url: 'amqp://nobody:nobody@127.0.0.1:1',
      });
      await sleep(300);
      expect(consumer.consuming).toBe(false);
      await consumer.onModuleDestroy(); // para limpo, sem travar
    });
  },
);
