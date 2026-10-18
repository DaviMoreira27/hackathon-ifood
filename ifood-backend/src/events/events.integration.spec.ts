import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import amqp, { type Channel, type ChannelModel } from 'amqplib';
import { MockDbService } from '../db/mock-db.service.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PaymentsService } from '../payments/payments.service.js';
import { OutboxPublisher } from './outbox-publisher.service.js';
import {
  PAYMENT_CONFIRMED,
  PAYMENTS_EXCHANGE,
  PAYMENTS_QUEUE,
  type PaymentConfirmedEvent,
} from './topology.js';

// Precisa de Postgres e RabbitMQ reais. Exemplo:
//   TEST_DATABASE_URL=postgresql://ifood:ifood@localhost:5433/ifood \
//   TEST_RABBITMQ_URL=amqp://ifood:ifood@localhost:5672 npm test
// Atenção: esvazia a fila ai-backend.payments; não rode com o ai-backend consumindo.
// Também não rode com outro mock do iFood ligado no mesmo banco: os publishers dividem o outbox
// e o segundo teste (broker fora) espera que só o app do teste publique.
describe.skipIf(
  !process.env.TEST_DATABASE_URL || !process.env.TEST_RABBITMQ_URL,
)('publicação de eventos (RabbitMQ)', () => {
  const PREFIX = `evt-${Date.now()}-`;
  const GOOD_URL = process.env.TEST_RABBITMQ_URL as string;
  const apps: INestApplication[] = [];
  let connection: ChannelModel;
  let channel: Channel;
  let seq = 0;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function boot(rabbitUrl: string) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.RABBITMQ_URL = rabbitUrl;
    const module = await Test.createTestingModule({
      imports: [PaymentsModule],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    apps.push(app);
    return app;
  }

  async function chargeAndPay(app: INestApplication) {
    const reference = `${PREFIX}${++seq}`;
    const payments = app.get(PaymentsService);
    const { token } = await payments.createCharge({
      reference,
      amountCents: 1234,
    });
    await payments.payByToken(token);
    return reference;
  }

  // Lê a fila até achar o evento da referência (ignora e confirma o resto).
  async function waitForEvent(reference: string, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const message = await channel.get(PAYMENTS_QUEUE, { noAck: false });
      if (!message) {
        await sleep(100);
        continue;
      }
      channel.ack(message);
      const event = JSON.parse(
        message.content.toString(),
      ) as PaymentConfirmedEvent;
      if (event.data.reference === reference) return { message, event };
    }
    throw new Error(`evento de ${reference} não chegou`);
  }

  beforeAll(async () => {
    connection = await amqp.connect(GOOD_URL);
    channel = await connection.createChannel();
    await channel.assertExchange(PAYMENTS_EXCHANGE, 'topic', { durable: true });
    await channel.assertQueue(PAYMENTS_QUEUE, { durable: true });
    await channel.purgeQueue(PAYMENTS_QUEUE);
  });

  // Cada teste sobe e derruba o próprio app: dois publishers vivos dividiriam o mesmo outbox.
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  afterAll(async () => {
    await channel.purgeQueue(PAYMENTS_QUEUE);
    const db = new (await import('pg')).default.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await db.query(
      `DELETE FROM mock_ifood.outbox WHERE payload->'data'->>'reference' LIKE $1`,
      [`${PREFIX}%`],
    );
    await db.query('DELETE FROM mock_ifood.charges WHERE reference LIKE $1', [
      `${PREFIX}%`,
    ]);
    await db.end();
    await connection.close();
  });

  it('publica payment.confirmed com os metadados certos e marca o outbox como publicado', async () => {
    const app = await boot(GOOD_URL);
    const reference = await chargeAndPay(app);

    const { message, event } = await waitForEvent(reference);

    expect(message.fields.exchange).toBe(PAYMENTS_EXCHANGE);
    expect(message.fields.routingKey).toBe(PAYMENT_CONFIRMED);
    expect(message.properties.deliveryMode).toBe(2); // persistente
    expect(message.properties.contentType).toBe('application/json');
    expect(message.properties.messageId).toBe(event.eventId);
    expect(event).toMatchObject({
      type: PAYMENT_CONFIRMED,
      version: 1,
      data: { reference, amountCents: 1234 },
    });

    const { rows } = await app
      .get(MockDbService)
      .pool.query(
        `SELECT published_at FROM mock_ifood.outbox WHERE payload->'data'->>'reference' = $1`,
        [reference],
      );
    expect(rows[0].published_at).not.toBeNull();
  });

  it('com o broker fora no momento do pagamento, nada se perde: o evento sai quando ele volta', async () => {
    const app = await boot('amqp://nobody:nobody@127.0.0.1:1');
    const reference = await chargeAndPay(app);
    const pool = app.get(MockDbService).pool;
    const published = () =>
      pool.query(
        `SELECT published_at FROM mock_ifood.outbox WHERE payload->'data'->>'reference' = $1`,
        [reference],
      );

    await sleep(1500);
    expect((await published()).rows[0].published_at).toBeNull();

    process.env.RABBITMQ_URL = GOOD_URL; // "o broker voltou"
    app.get(OutboxPublisher).kick();

    const { event } = await waitForEvent(reference);
    expect(event.data.reference).toBe(reference);
    expect((await published()).rows[0].published_at).not.toBeNull();
  });
});
