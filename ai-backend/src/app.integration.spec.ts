import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createPayingOrder, deleteTestUsers } from '../test/fixtures.js';
import { AgentService } from './agent/agent.service.js';
import { AppModule } from './app.module.js';
import { DbService } from './db/db.service.js';
import { GroupOrderTools } from './group-order/group-order.tools.js';
import { PaymentEventsConsumer } from './payments/payment-events.consumer.js';
import { PaymentsService } from './payments/payments.service.js';
import { PAYMENT_CONFIRMED } from './payments/topology.js';

// Bot do Telegram simulado: o resto do app (módulos, DI, consumidor, listeners) é o de verdade.
const bot = vi.hoisted(() => ({
  sendMessage: vi.fn().mockResolvedValue({}),
  sendChatAction: vi.fn().mockResolvedValue(true),
  stopPolling: vi.fn(),
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
}));
vi.mock('node-telegram-bot-api', () => ({
  default: class {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      bot.handlers[event] = handler;
    }
    sendMessage = bot.sendMessage;
    sendChatAction = bot.sendChatAction;
    stopPolling = bot.stopPolling;
  },
}));

// Sobe o AppModule inteiro. Precisa de Postgres e RabbitMQ reais:
//   TEST_DATABASE_URL=... TEST_RABBITMQ_URL=... npm test
describe.skipIf(
  !process.env.TEST_DATABASE_URL || !process.env.TEST_RABBITMQ_URL,
)('AppModule (fiação completa)', () => {
  const CHAT = 4_000_000_000 + Math.floor(Math.random() * 1_000_000);
  let app: INestApplication;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(condition: () => boolean, ms = 8000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (condition()) return;
      await sleep(25);
    }
    throw new Error('timeout esperando condição');
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.RABBITMQ_URL = process.env.TEST_RABBITMQ_URL;
    process.env.TELEGRAM_BOT_TOKEN = 'token-falso';
    process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await deleteTestUsers(app.get(DbService).db, [CHAT]);
    await app.close();
  });

  it('resolve todas as dependências e o consumidor passa a consumir', async () => {
    expect(app.get(AgentService)).toBeInstanceOf(AgentService);
    expect(app.get(GroupOrderTools).has('group_confirm_order')).toBe(true);
    const consumer = app.get(PaymentEventsConsumer);
    await waitFor(() => consumer.consuming);
    expect(bot.handlers).toHaveProperty('message');
  });

  it('a rota de redirect do OAuth existe e recusa state desconhecido', async () => {
    const response = await request(app.getHttpServer()).get(
      '/redirect?code=x&state=nao-existe',
    );
    expect(response.status).toBe(403);
    expect(response.text).toContain('Mande uma nova mensagem no Telegram');
  });

  it('pagamento confirmado avisa o dono no Telegram (service → listener → bot)', async () => {
    const db = app.get(DbService).db;
    const order = await createPayingOrder(db, CHAT, [
      {
        restaurant: 'Pizzaria',
        subtotal: '40.00',
        total: '45.00',
        payers: [
          { name: 'Ana', amount: '33.75' },
          { name: 'Bia', amount: '11.25' },
        ],
      },
    ]);
    const [ana, bia] = order.carts[0].payers;
    const payments = app.get(PaymentsService);
    const event = (paymentId: number, amountCents: number) => ({
      eventId: `app-${paymentId}-${Math.random()}`,
      type: PAYMENT_CONFIRMED as typeof PAYMENT_CONFIRMED,
      version: 1 as const,
      occurredAt: new Date().toISOString(),
      data: {
        paymentId: `c-${paymentId}`,
        reference: String(paymentId),
        amountCents,
        paidAt: new Date().toISOString(),
      },
    });

    await payments.applyConfirmedEvent(event(ana.paymentId, 3375));
    expect(bot.sendMessage).toHaveBeenLastCalledWith(
      CHAT,
      expect.stringContaining('<b>Ana</b> pagou R$ 33,75 (Pizzaria).'),
      { parse_mode: 'HTML' },
    );
    expect(bot.sendMessage.mock.lastCall![1]).toContain('Faltam: Bia.');

    await payments.applyConfirmedEvent(event(bia.paymentId, 1125));
    expect(bot.sendMessage.mock.lastCall![1]).toContain(
      'Todos os pagamentos foram confirmados',
    );
  });
});
