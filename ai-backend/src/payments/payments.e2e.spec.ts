import { eq } from 'drizzle-orm';
import { createUser, deleteTestUsers } from '../../test/fixtures.js';
import { DbService } from '../db/db.service.js';
import { orders, payments } from '../db/schema.js';
import { GroupOrderService } from '../group-order/group-order.service.js';
import {
  PaymentEventsConsumer,
  defaultConsumerOptions,
} from './payment-events.consumer.js';
import { PaymentProviderClient } from './payment-provider.client.js';
import { PaymentsService, type PaymentApplied } from './payments.service.js';

// Ponta a ponta com tudo de verdade: mock do iFood rodando (HTTP), Postgres e RabbitMQ.
//   (no ifood-backend)  npm run build && PORT=3001 DATABASE_URL=... RABBITMQ_URL=... node dist/main
//   (aqui)              TEST_DATABASE_URL=... TEST_RABBITMQ_URL=... TEST_MOCK_URL=http://localhost:3001 npm test
// Usa a fila padrão ai-backend.payments: não rode com o ai-backend de verdade consumindo.
const enabled =
  !!process.env.TEST_DATABASE_URL &&
  !!process.env.TEST_RABBITMQ_URL &&
  !!process.env.TEST_MOCK_URL;

describe.skipIf(!enabled)(
  'pagamento ponta a ponta (mock → RabbitMQ → ai-backend)',
  () => {
    const MOCK = process.env.TEST_MOCK_URL as string;
    const CHAT = 5_000_000_000 + Math.floor(Math.random() * 1_000_000);
    let database: DbService;
    let service: PaymentsService;
    let groupOrder: GroupOrderService;
    let consumer: PaymentEventsConsumer;
    let applied: PaymentApplied[];
    let userId: number;

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    async function waitFor(
      condition: () => Promise<boolean> | boolean,
      ms = 10_000,
    ) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (await condition()) return;
        await sleep(50);
      }
      throw new Error('timeout esperando condição');
    }
    const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);
    const pay = (url: string) =>
      fetch(`${MOCK}/payments/by-token/${tokenOf(url)}/pay`, {
        method: 'POST',
      });
    const statusOf = async (id: number) =>
      (await database.db.select().from(payments).where(eq(payments.id, id)))[0]
        .status;

    beforeAll(async () => {
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
      process.env.PAYMENTS_API_URL = MOCK;
      database = new DbService();
      service = new PaymentsService(database, new PaymentProviderClient());
      groupOrder = new GroupOrderService(database, service);
      applied = [];
      service.onPaymentApplied((a) => void applied.push(a));
      consumer = new PaymentEventsConsumer(service, {
        ...defaultConsumerOptions(),
        url: process.env.TEST_RABBITMQ_URL as string,
      });
      userId = (await createUser(database.db, CHAT)).id;
    });

    afterAll(async () => {
      await consumer.onModuleDestroy();
      await deleteTestUsers(database.db, [CHAT]);
      await database.onModuleDestroy();
    });

    it('confirma o pedido, cada pessoa paga pelo seu link e o pedido fecha sozinho', async () => {
      for (const name of ['Ana', 'Bia', 'Caio'])
        await groupOrder.addParticipant(userId, name);
      await groupOrder.syncCart(userId, {
        ifoodCartId: 'e2e-pizza',
        restaurantName: 'Pizzaria',
        subtotal: 40,
        total: 45,
        items: [
          { itemId: 'pizza', name: 'Pizza', unitPrice: 30, quantity: 1 },
          { itemId: 'refri', name: 'Refri', unitPrice: 5, quantity: 2 },
        ],
      });
      await groupOrder.syncCart(userId, {
        ifoodCartId: 'e2e-burger',
        restaurantName: 'Burger',
        subtotal: 20,
        total: 22,
        items: [{ itemId: 'x', name: 'X-Bacon', unitPrice: 20, quantity: 1 }],
      });
      const assign = (cart: string, item: string, who: string) =>
        groupOrder.assignPayer(userId, {
          ifoodCartId: cart,
          itemId: item,
          participantName: who,
        });
      await assign('e2e-pizza', 'pizza', 'Ana');
      await assign('e2e-pizza', 'refri', 'Bia');
      await assign('e2e-burger', 'x', 'Caio');

      // 1) confirmar: cobranças criadas no mock via HTTP, links apontando para o front (localhost)
      const confirmed = await groupOrder.confirmOrder(userId);
      expect(confirmed.failed).toEqual([]);
      expect(confirmed.links.map((l) => [l.participant, l.amount])).toEqual([
        ['Ana', 'R$ 33,75'],
        ['Bia', 'R$ 11,25'],
        ['Caio', 'R$ 22,00'],
      ]);
      for (const link of confirmed.links) {
        expect(link.url).toMatch(
          /^http:\/\/localhost:5173\/pay\/[A-Za-z0-9_-]{43}$/,
        );
      }
      const [ana, bia, caio] = confirmed.links;

      // 2) o front consulta a cobrança pelo token e só enxerga a parte daquela pessoa
      const view = await (
        await fetch(`${MOCK}/payments/by-token/${tokenOf(ana.url)}`)
      ).json();
      expect(view).toMatchObject({ amountCents: 3375, status: 'pending' });
      expect(view.description).toContain('Pizzaria — Ana: 1x Pizza');

      // 3) Ana paga com o consumidor DESLIGADO: o evento espera na fila (durável)
      expect((await pay(ana.url)).status).toBe(201);
      await sleep(1500);
      const anaPayment = (
        await database.db
          .select()
          .from(payments)
          .where(eq(payments.status, 'pending'))
      ).length;
      expect(anaPayment).toBeGreaterThanOrEqual(3); // nada foi aplicado ainda
      expect(applied).toHaveLength(0);

      // 4) o consumidor sobe e aplica o pagamento que estava esperando
      consumer.onModuleInit();
      await waitFor(() => applied.length === 1);
      expect(applied[0]).toMatchObject({
        participantName: 'Ana',
        amountCents: 3375,
        cartPaid: false,
        orderPaid: false,
        pendingParticipants: expect.arrayContaining(['Bia', 'Caio']),
        ownerChatId: CHAT,
      });

      // 5) pagar de novo o mesmo link é recusado pelo mock
      const again = await pay(ana.url);
      expect(again.status).toBe(409);
      expect((await again.json()).status).toBe('paid');

      // 6) os outros pagam: o carrinho fecha, depois o pedido
      expect((await pay(bia.url)).status).toBe(201);
      await waitFor(() => applied.length === 2);
      expect(applied[1]).toMatchObject({
        participantName: 'Bia',
        cartPaid: true,
        orderPaid: false,
      });

      expect((await pay(caio.url)).status).toBe(201);
      await waitFor(() => applied.length === 3);
      expect(applied[2]).toMatchObject({
        participantName: 'Caio',
        cartPaid: true,
        orderPaid: true,
      });

      const [order] = await database.db
        .select()
        .from(orders)
        .where(eq(orders.ownerUserId, userId));
      expect(order.status).toBe('paid');
      expect(await groupOrder.hasPaidOrder(userId)).toBe(true);
      for (const row of await database.db.select().from(payments)) {
        if (row.externalPaymentId?.length)
          expect(['paid', 'void', 'pending']).toContain(row.status);
      }

      // 7) depois de pago não dá mais para reabrir
      await expect(groupOrder.reopenOrder(userId)).rejects.toThrow(
        /totalmente pago/,
      );
      expect(
        await statusOf((await database.db.select().from(payments))[0].id),
      ).toBeDefined();
    });
  },
);
