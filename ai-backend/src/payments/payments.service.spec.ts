import { eq, inArray } from 'drizzle-orm';
import { createPayingOrder, deleteTestUsers } from '../../test/fixtures.js';
import { DbService } from '../db/db.service.js';
import { carts, orders, payments, processedEvents } from '../db/schema.js';
import { PaymentProviderClient } from './payment-provider.client.js';
import {
  PaymentsService,
  UnrecoverableEventError,
} from './payments.service.js';
import { PAYMENT_CONFIRMED, type PaymentConfirmedEvent } from './topology.js';

// Roda contra um Postgres real (schema de db/init.sql). Exemplo:
//   TEST_DATABASE_URL=postgresql://ifood:ifood@localhost:5433/ifood npm test
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'PaymentsService.applyConfirmedEvent',
  () => {
    const BASE = 7_000_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
    const chatIds: number[] = [];
    let nextChat = 0;
    let database: DbService;
    let service: PaymentsService;
    let applied: unknown[];

    const event = (
      paymentId: number,
      amountCents: number,
      eventId?: string,
    ): PaymentConfirmedEvent => ({
      eventId: eventId ?? `${BASE}-${Math.random()}`,
      type: PAYMENT_CONFIRMED,
      version: 1,
      occurredAt: new Date().toISOString(),
      data: {
        paymentId: `charge-${paymentId}`,
        reference: String(paymentId),
        amountCents,
        paidAt: new Date().toISOString(),
      },
    });
    const newChat = () => {
      const id = BASE + ++nextChat;
      chatIds.push(id);
      return id;
    };
    const statusOf = async (
      table: typeof payments | typeof carts | typeof orders,
      id: number,
    ) =>
      (
        await database.db
          .select()
          .from(table as typeof payments)
          .where(eq((table as typeof payments).id, id))
      )[0].status;

    beforeAll(() => {
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
      database = new DbService();
    });

    // Serviço novo a cada teste: os listeners não vazam de um teste para o outro.
    beforeEach(() => {
      applied = [];
      service = new PaymentsService(database, new PaymentProviderClient());
      service.onPaymentApplied((a) => void applied.push(a));
    });

    afterAll(async () => {
      await deleteTestUsers(database.db, chatIds);
      await database.db
        .delete(processedEvents)
        .where(inArray(processedEvents.type, [PAYMENT_CONFIRMED]))
        .catch(() => undefined);
      await database.onModuleDestroy();
    });

    it('aplica o pagamento e só fecha carrinho e pedido quando o último paga', async () => {
      const chat = newChat();
      const order = await createPayingOrder(database.db, chat, [
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

      const first = await service.applyConfirmedEvent(
        event(ana.paymentId, 3375),
      );
      expect(first).toMatchObject({
        participantName: 'Ana',
        restaurantName: 'Pizzaria',
        amountCents: 3375,
        cartPaid: false,
        orderPaid: false,
        pendingParticipants: ['Bia'],
        ownerChatId: chat,
      });
      expect(await statusOf(payments, ana.paymentId)).toBe('paid');
      expect(await statusOf(carts, order.carts[0].cartId)).toBe('confirmed');
      expect(await statusOf(orders, order.orderId)).toBe('paying');

      const last = await service.applyConfirmedEvent(
        event(bia.paymentId, 1125),
      );
      expect(last).toMatchObject({
        cartPaid: true,
        orderPaid: true,
        pendingParticipants: [],
      });
      expect(await statusOf(carts, order.carts[0].cartId)).toBe('paid');
      expect(await statusOf(orders, order.orderId)).toBe('paid');
      expect(applied).toHaveLength(2);
    });

    it('com dois carrinhos, o pedido só fica pago quando os dois estão pagos', async () => {
      const order = await createPayingOrder(database.db, newChat(), [
        {
          restaurant: 'A',
          subtotal: '10.00',
          total: '10.00',
          payers: [{ name: 'Ana', amount: '10.00' }],
        },
        {
          restaurant: 'B',
          subtotal: '20.00',
          total: '20.00',
          payers: [{ name: 'Bia', amount: '20.00' }],
        },
      ]);
      const [cartA, cartB] = order.carts;

      const a = await service.applyConfirmedEvent(
        event(cartA.payers[0].paymentId, 1000),
      );
      expect(a).toMatchObject({ cartPaid: true, orderPaid: false });
      expect(await statusOf(orders, order.orderId)).toBe('paying');

      const b = await service.applyConfirmedEvent(
        event(cartB.payers[0].paymentId, 2000),
      );
      expect(b).toMatchObject({ cartPaid: true, orderPaid: true });
      expect(await statusOf(orders, order.orderId)).toBe('paid');
    });

    it('é idempotente: o mesmo evento, ou outro evento do mesmo pagamento, não aplica duas vezes', async () => {
      const order = await createPayingOrder(database.db, newChat(), [
        {
          restaurant: 'A',
          subtotal: '10.00',
          total: '10.00',
          payers: [{ name: 'Ana', amount: '10.00' }],
        },
      ]);
      const paymentId = order.carts[0].payers[0].paymentId;
      const e = event(paymentId, 1000, `${BASE}-same`);

      expect(await service.applyConfirmedEvent(e)).not.toBeNull();
      expect(await service.applyConfirmedEvent(e)).toBeNull(); // mesmo eventId
      expect(
        await service.applyConfirmedEvent(event(paymentId, 1000)),
      ).toBeNull(); // outro eventId
      expect(applied).toHaveLength(1);
    });

    it('eventos simultâneos do mesmo pedido: só um enxerga "todos pagaram"', async () => {
      const order = await createPayingOrder(database.db, newChat(), [
        {
          restaurant: 'A',
          subtotal: '10.00',
          total: '10.00',
          payers: [{ name: 'Ana', amount: '10.00' }],
        },
        {
          restaurant: 'B',
          subtotal: '10.00',
          total: '10.00',
          payers: [{ name: 'Bia', amount: '10.00' }],
        },
        {
          restaurant: 'C',
          subtotal: '10.00',
          total: '10.00',
          payers: [{ name: 'Caio', amount: '10.00' }],
        },
      ]);

      const results = await Promise.all(
        order.carts.map((c) =>
          service.applyConfirmedEvent(event(c.payers[0].paymentId, 1000)),
        ),
      );

      expect(results.every((r) => r !== null)).toBe(true);
      expect(results.filter((r) => r?.orderPaid)).toHaveLength(1);
      expect(await statusOf(orders, order.orderId)).toBe('paid');
    });

    it('valor divergente é definitivo e não deixa rastro (rollback)', async () => {
      const order = await createPayingOrder(database.db, newChat(), [
        {
          restaurant: 'A',
          subtotal: '10.00',
          total: '10.00',
          payers: [{ name: 'Ana', amount: '10.00' }],
        },
      ]);
      const paymentId = order.carts[0].payers[0].paymentId;
      const e = event(paymentId, 999);

      await expect(service.applyConfirmedEvent(e)).rejects.toBeInstanceOf(
        UnrecoverableEventError,
      );

      expect(await statusOf(payments, paymentId)).toBe('pending');
      const logged = await database.db
        .select()
        .from(processedEvents)
        .where(eq(processedEvents.eventId, e.eventId));
      expect(logged).toHaveLength(0);
      expect(applied).toHaveLength(0);
    });

    it('pagamento anulado, inexistente ou com reference inválida são definitivos', async () => {
      const order = await createPayingOrder(database.db, newChat(), [
        {
          restaurant: 'A',
          subtotal: '10.00',
          total: '10.00',
          payers: [{ name: 'Ana', amount: '10.00' }],
        },
      ]);
      const paymentId = order.carts[0].payers[0].paymentId;
      await database.db
        .update(payments)
        .set({ status: 'void' })
        .where(eq(payments.id, paymentId));

      await expect(
        service.applyConfirmedEvent(event(paymentId, 1000)),
      ).rejects.toBeInstanceOf(UnrecoverableEventError);
      await expect(
        service.applyConfirmedEvent(event(999_999_999, 1000)),
      ).rejects.toBeInstanceOf(UnrecoverableEventError);
      const bad = event(1, 1000);
      bad.data.reference = 'abc';
      await expect(service.applyConfirmedEvent(bad)).rejects.toBeInstanceOf(
        UnrecoverableEventError,
      );
    });

    it('uma falha no listener (ex.: Telegram fora) não desfaz o pagamento', async () => {
      const order = await createPayingOrder(database.db, newChat(), [
        {
          restaurant: 'A',
          subtotal: '10.00',
          total: '10.00',
          payers: [{ name: 'Ana', amount: '10.00' }],
        },
      ]);
      const paymentId = order.carts[0].payers[0].paymentId;
      service.onPaymentApplied(() => {
        throw new Error('telegram fora do ar');
      });

      await expect(
        service.applyConfirmedEvent(event(paymentId, 1000)),
      ).resolves.not.toBeNull();
      expect(await statusOf(payments, paymentId)).toBe('paid');
    });
  },
);
