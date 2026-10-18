import { eq } from 'drizzle-orm';
import { createUser, deleteTestUsers } from '../../test/fixtures.js';
import { DbService } from '../db/db.service.js';
import { pgErrorCode } from '../db/errors.js';
import {
  cartItems,
  cartPayers,
  carts,
  orders,
  payments,
} from '../db/schema.js';
import type {
  CancelResult,
  Charge,
  CreateChargeRequest,
  PaymentProviderClient,
} from '../payments/payment-provider.client.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PAYMENT_CONFIRMED } from '../payments/topology.js';
import { GroupOrderError } from './group-order.errors.js';
import {
  GroupOrderService,
  type CartSummary,
  type SyncCartInput,
} from './group-order.service.js';

class FakeProvider {
  created: CreateChargeRequest[] = [];
  cancelled: string[] = [];
  failCreateFor = new Set<string>(); // nomes na description
  cancelResults = new Map<string, CancelResult>();
  failCancel = false;

  createCharge = async (request: CreateChargeRequest): Promise<Charge> => {
    if (
      [...this.failCreateFor].some((name) => request.description.includes(name))
    ) {
      throw new Error('provedor fora do ar');
    }
    this.created.push(request);
    return {
      id: `ext-${request.reference}`,
      token: `tok-${request.reference}`,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
  };
  cancelCharge = async (reference: string): Promise<CancelResult> => {
    if (this.failCancel) throw new Error('provedor fora do ar');
    this.cancelled.push(reference);
    return this.cancelResults.get(reference) ?? 'cancelled';
  };
}

const pizzaria = (items?: SyncCartInput['items']): SyncCartInput => ({
  ifoodCartId: 'cart-pizza',
  restaurantName: 'Pizzaria',
  subtotal: 40,
  total: 45,
  items: items ?? [
    { itemId: 'pizza', name: 'Pizza', unitPrice: 30, quantity: 1 },
    { itemId: 'refri', name: 'Refri', unitPrice: 5, quantity: 2 },
  ],
});
const burger = (): SyncCartInput => ({
  ifoodCartId: 'cart-burger',
  restaurantName: 'Burger',
  subtotal: 20,
  total: 22,
  items: [{ itemId: 'x-bacon', name: 'X-Bacon', unitPrice: 20, quantity: 1 }],
});

// Roda contra um Postgres real (schema de db/init.sql). Exemplo:
//   TEST_DATABASE_URL=postgresql://ifood:ifood@localhost:5433/ifood npm test
describe.skipIf(!process.env.TEST_DATABASE_URL)('GroupOrderService', () => {
  const BASE = 6_000_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
  const chatIds: number[] = [];
  let database: DbService;
  let provider: FakeProvider;
  let payments_: PaymentsService;
  let service: GroupOrderService;
  let userId: number;

  const setup = async (names: string[] = ['Ana', 'Bia', 'Caio']) => {
    for (const name of names) await service.addParticipant(userId, name);
  };
  const orderRow = async () =>
    (
      await database.db
        .select()
        .from(orders)
        .where(eq(orders.ownerUserId, userId))
    ).sort((a, b) => b.id - a.id)[0];
  const payRows = async (status?: 'pending' | 'paid' | 'void') =>
    (
      await database.db
        .select()
        .from(payments)
        .innerJoin(carts, eq(carts.id, payments.cartId))
        .where(eq(carts.orderId, (await orderRow()).id))
    )
      .map((r) => r.payments)
      .filter((p) => !status || p.status === status);
  const cartOf = async (ifoodCartId: string) =>
    (
      await database.db
        .select()
        .from(carts)
        .where(eq(carts.orderId, (await orderRow()).id))
    ).find((c) => c.ifoodCartId === ifoodCartId);
  const markPaid = async (paymentId: number, amountCents: number) =>
    payments_.applyConfirmedEvent({
      eventId: `${BASE}-${paymentId}-${Math.random()}`,
      type: PAYMENT_CONFIRMED,
      version: 1,
      occurredAt: new Date().toISOString(),
      data: {
        paymentId: `c-${paymentId}`,
        reference: String(paymentId),
        amountCents,
        paidAt: new Date().toISOString(),
      },
    });
  const rejects = (promise: Promise<unknown>, message: RegExp) =>
    expect(promise).rejects.toThrow(message);

  beforeAll(() => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    database = new DbService();
  });

  beforeEach(async () => {
    provider = new FakeProvider();
    payments_ = new PaymentsService(
      database,
      provider as unknown as PaymentProviderClient,
    );
    service = new GroupOrderService(database, payments_);
    const chat = BASE + chatIds.length + 1;
    chatIds.push(chat);
    userId = (await createUser(database.db, chat)).id;
  });

  afterAll(async () => {
    await deleteTestUsers(database.db, chatIds);
    await database.onModuleDestroy();
  });

  describe('participantes e carrinhos', () => {
    it('cria o pedido ao cadastrar o primeiro participante e ignora duplicados (caixa e acento)', async () => {
      const first = await service.addParticipant(userId, '  João  Silva ');
      expect(first).toMatchObject({ created: true, participant: 'João Silva' });

      const again = await service.addParticipant(userId, 'joao silva');
      expect(again).toMatchObject({
        created: false,
        participant: 'João Silva',
      });
      expect(again.participants).toEqual(['João Silva']);
      expect((await orderRow()).status).toBe('collecting');
    });

    it('sincroniza itens preservando o pagador e liberando quem ficou sem itens', async () => {
      await setup();
      await service.syncCart(userId, pizzaria());
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'pizza',
        participantName: 'Ana',
      });
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'refri',
        participantName: 'Bia',
      });

      // preço do refri muda e a pizza continua: pagadores preservados
      const resynced = (await service.syncCart(
        userId,
        pizzaria([
          { itemId: 'pizza', name: 'Pizza', unitPrice: 30, quantity: 1 },
          { itemId: 'refri', name: 'Refri', unitPrice: 6, quantity: 2 },
        ]),
      )) as CartSummary;
      expect(resynced.items.map((i) => i.payer)).toEqual(['Ana', 'Bia']);
      expect(resynced.warnings.join()).toContain('não bate com o subtotal');

      // o refri sai do carrinho: Bia deixa de ser pagadora e pode pagar outro carrinho
      await service.syncCart(userId, {
        ...pizzaria([
          { itemId: 'pizza', name: 'Pizza', unitPrice: 30, quantity: 1 },
        ]),
        subtotal: 30,
        total: 33,
      });
      const pizzaPayers = await database.db
        .select()
        .from(cartPayers)
        .where(eq(cartPayers.cartId, (await cartOf('cart-pizza'))!.id));
      expect(pizzaPayers).toHaveLength(1); // só a Ana; a Bia ficou livre
      await service.syncCart(userId, burger());
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-burger',
        itemId: 'x-bacon',
        participantName: 'Bia',
      });
    });

    it('avisa de itens sem pagador e rejeita entradas inválidas', async () => {
      const summary = (await service.syncCart(
        userId,
        pizzaria(),
      )) as CartSummary;
      expect(summary.warnings.join()).toContain(
        'Itens sem pagador: Pizza, Refri',
      );

      await rejects(
        service.syncCart(
          userId,
          pizzaria([
            { itemId: 'a', name: 'A', unitPrice: 1, quantity: 1 },
            { itemId: 'a', name: 'B', unitPrice: 1, quantity: 1 },
          ]),
        ),
        /item_id repetido/,
      );
      await rejects(
        service.syncCart(
          userId,
          pizzaria([{ itemId: 'a', name: 'A', unitPrice: -1, quantity: 1 }]),
        ),
        /negativo/,
      );
      await rejects(
        service.syncCart(
          userId,
          pizzaria([{ itemId: 'a', name: 'A', unitPrice: 1.999, quantity: 1 }]),
        ),
        /casas decimais/,
      );
    });

    it('carrinho sem itens é removido do pedido', async () => {
      await service.syncCart(userId, burger());
      const removed = await service.syncCart(userId, {
        ...burger(),
        items: [],
      });
      expect(removed).toMatchObject({ removed: true });
      expect(await cartOf('cart-burger')).toBeUndefined();
    });
  });

  describe('regra: uma pessoa paga em um carrinho só', () => {
    beforeEach(async () => {
      await setup();
      await service.syncCart(userId, pizzaria());
      await service.syncCart(userId, burger());
    });

    it('recusa que a mesma pessoa pague dois carrinhos, dizendo qual já paga', async () => {
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'pizza',
        participantName: 'Ana',
      });

      await rejects(
        service.assignPayer(userId, {
          ifoodCartId: 'cart-burger',
          itemId: 'x-bacon',
          participantName: 'ana',
        }),
        /Ana já paga o carrinho Pizzaria/,
      );
      // outro item do MESMO carrinho pode ter a mesma pagadora
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'refri',
        participantName: 'Ana',
      });
    });

    it('passar o item para outra pessoa libera a anterior para pagar o outro carrinho', async () => {
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'pizza',
        participantName: 'Ana',
      });
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'refri',
        participantName: 'Ana',
      });
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'pizza',
        participantName: 'Bia',
      });
      // Ana ainda paga o refri; troca o refri também
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'refri',
        participantName: 'Bia',
      });

      await service.assignPayer(userId, {
        ifoodCartId: 'cart-burger',
        itemId: 'x-bacon',
        participantName: 'Ana',
      });
    });

    it('o banco também barra, mesmo que o código falhe (UNIQUE e FK composta)', async () => {
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'pizza',
        participantName: 'Ana',
      });
      const pizzaCart = (await cartOf('cart-pizza'))!;
      const burgerCart = (await cartOf('cart-burger'))!;
      const [row] = await database.db
        .select()
        .from(cartPayers)
        .where(eq(cartPayers.cartId, pizzaCart.id));

      // Ana como pagadora do segundo carrinho: UNIQUE (participant_id)
      const duplicate = database.db
        .insert(cartPayers)
        .values({ cartId: burgerCart.id, participantId: row.participantId });
      await expect(duplicate).rejects.toSatisfy(
        (e) => pgErrorCode(e) === '23505',
      );

      // item do burger apontando para Ana, que não é pagadora do burger: FK composta
      const stolen = database.db
        .update(cartItems)
        .set({ payerParticipantId: row.participantId })
        .where(eq(cartItems.cartId, burgerCart.id));
      await expect(stolen).rejects.toSatisfy((e) => pgErrorCode(e) === '23503');
    });

    it('mensagens de erro listam as opções válidas', async () => {
      await rejects(
        service.assignPayer(userId, {
          ifoodCartId: 'nao-existe',
          itemId: 'pizza',
          participantName: 'Ana',
        }),
        /Registrados: cart-pizza \(Pizzaria\), cart-burger \(Burger\)/,
      );
      await rejects(
        service.assignPayer(userId, {
          ifoodCartId: 'cart-pizza',
          itemId: 'nope',
          participantName: 'Ana',
        }),
        /Itens: pizza \(Pizza\), refri \(Refri\)/,
      );
      await rejects(
        service.assignPayer(userId, {
          ifoodCartId: 'cart-pizza',
          itemId: 'pizza',
          participantName: 'Zeca',
        }),
        /Participantes: Ana, Bia, Caio/,
      );
    });
  });

  describe('confirmação', () => {
    const assignAll = async () => {
      await setup();
      await service.syncCart(userId, pizzaria());
      await service.syncCart(userId, burger());
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'pizza',
        participantName: 'Ana',
      });
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'refri',
        participantName: 'Bia',
      });
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-burger',
        itemId: 'x-bacon',
        participantName: 'Caio',
      });
    };

    it('divide as taxas pelos itens de cada um, cria as cobranças e devolve os links', async () => {
      await assignAll();

      const result = await service.confirmOrder(userId);

      expect(result.alreadyConfirmed).toBe(false);
      expect(result.failed).toEqual([]);
      expect(result.payments.map((p) => [p.participant, p.amount])).toEqual([
        ['Ana', 'R$ 33,75'],
        ['Bia', 'R$ 11,25'],
        ['Caio', 'R$ 22,00'],
      ]);
      expect(result.links.map((l) => l.participant)).toEqual([
        'Ana',
        'Bia',
        'Caio',
      ]);
      expect(result.links[0].url).toMatch(
        /^http:\/\/localhost:5173\/pay\/tok-\d+$/,
      );
      expect(provider.created.map((c) => c.amountCents)).toEqual([
        3375, 1125, 2200,
      ]);
      expect(provider.created[0].description).toContain(
        'Pizzaria — Ana: 1x Pizza',
      );

      expect((await orderRow()).status).toBe('paying');
      const cartStatuses = (
        await database.db
          .select()
          .from(carts)
          .where(eq(carts.orderId, (await orderRow()).id))
      ).map((c) => c.status);
      expect(cartStatuses).toEqual(['confirmed', 'confirmed']);
      // cada referência enviada ao provedor é o id do pagamento
      const ids = (await payRows()).map((p) => String(p.id));
      expect(provider.created.map((c) => c.reference)).toEqual(ids);
    });

    it('não confirma com item sem pagador, subtotal errado ou carrinho vazio, e não deixa rastro', async () => {
      await setup();
      await service.syncCart(userId, pizzaria());
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'pizza',
        participantName: 'Ana',
      });
      await rejects(service.confirmOrder(userId), /Itens sem pagador: Refri/);

      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'refri',
        participantName: 'Bia',
      });
      await service.syncCart(userId, { ...pizzaria(), subtotal: 99 });
      await rejects(service.confirmOrder(userId), /não bate com o subtotal/);

      expect(await payRows()).toHaveLength(0);
      expect((await orderRow()).status).toBe('collecting');
      expect(provider.created).toHaveLength(0);
    });

    it('sem nada para confirmar', async () => {
      await rejects(service.confirmOrder(userId), /Não há pedido/);
      await service.addParticipant(userId, 'Ana');
      await rejects(service.confirmOrder(userId), /não tem carrinhos/);
    });

    it('confirmar de novo não duplica nada: devolve os mesmos links', async () => {
      await assignAll();
      const first = await service.confirmOrder(userId);

      const second = await service.confirmOrder(userId);

      expect(second.alreadyConfirmed).toBe(true);
      expect(second.links.map((l) => l.url)).toEqual(
        first.links.map((l) => l.url),
      );
      expect(await payRows()).toHaveLength(3);
      expect(provider.created).toHaveLength(3);
    });

    it('se o provedor falha, o pedido fica confirmado e o link é gerado na próxima chamada', async () => {
      await assignAll();
      provider.failCreateFor.add('Bia');

      const first = await service.confirmOrder(userId);
      expect(first.failed).toEqual(['Bia']);
      expect(first.links.map((l) => l.participant)).toEqual(['Ana', 'Caio']);
      expect((await service.getOrderView(userId)).problems?.join()).toContain(
        'link de Bia ainda não foi gerado',
      );

      provider.failCreateFor.clear();
      const second = await service.confirmOrder(userId);
      expect(second.failed).toEqual([]);
      expect(second.links.map((l) => l.participant)).toEqual([
        'Ana',
        'Bia',
        'Caio',
      ]);
      expect(await payRows()).toHaveLength(3);
    });

    it('com o pedido em pagamento, edições são recusadas com a dica de reabrir', async () => {
      await assignAll();
      await service.confirmOrder(userId);

      await rejects(service.syncCart(userId, burger()), /group_reopen_order/);
      await rejects(
        service.addParticipant(userId, 'Dani'),
        /group_reopen_order/,
      );
      await rejects(
        service.assignPayer(userId, {
          ifoodCartId: 'cart-burger',
          itemId: 'x-bacon',
          participantName: 'Ana',
        }),
        /group_reopen_order/,
      );
    });
  });

  describe('reabrir, cancelar e finalizar', () => {
    const confirmed = async () => {
      await setup(['Ana', 'Bia']);
      await service.syncCart(userId, pizzaria());
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'pizza',
        participantName: 'Ana',
      });
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'refri',
        participantName: 'Bia',
      });
      return service.confirmOrder(userId);
    };

    it('reabrir anula os links, volta a editar e permite confirmar de novo com novas cobranças', async () => {
      await confirmed();
      const oldIds = (await payRows()).map((p) => String(p.id));

      const reopened = await service.reopenOrder(userId);

      expect(reopened.status).toBe('collecting');
      expect(provider.cancelled).toEqual(oldIds);
      expect((await payRows('void')).map((p) => String(p.id))).toEqual(oldIds);
      expect((await orderRow()).status).toBe('collecting');

      await service.syncCart(userId, {
        ...pizzaria(),
        subtotal: 40,
        total: 50,
      });
      const again = await service.confirmOrder(userId);
      expect(again.payments.map((p) => p.amount)).toEqual([
        'R$ 37,50',
        'R$ 12,50',
      ]);
      expect(again.links).toHaveLength(2);
      expect(
        (await payRows('pending')).every((p) => !oldIds.includes(String(p.id))),
      ).toBe(true);
    });

    it('não reabre nem cancela depois que alguém pagou, e nem chega a falar com o provedor', async () => {
      const result = await confirmed();
      const [ana] = await payRows('pending');
      await markPaid(ana.id, 3375);
      expect(result.payments).toHaveLength(2);

      await rejects(service.reopenOrder(userId), /Ana já pagou/);
      await rejects(service.cancelOrder(userId), /Ana já pagou/);
      expect(provider.cancelled).toHaveLength(0);
      expect((await orderRow()).status).toBe('paying');
    });

    it('se o provedor informa que alguém acabou de pagar, aborta e reemite os links já cancelados', async () => {
      await confirmed();
      const [first, second] = await payRows('pending');
      provider.cancelResults.set(String(second.id), 'paid'); // corrida: pagou no último instante

      await rejects(service.reopenOrder(userId), /acabou de pagar/);

      expect((await orderRow()).status).toBe('paying');
      const pending = await payRows('pending');
      // o link cancelado da primeira foi trocado por uma cobrança nova (com link)
      expect(pending.map((p) => p.id)).toContain(second.id);
      expect(pending.map((p) => p.id)).not.toContain(first.id);
      expect(pending.every((p) => p.payUrl)).toBe(true);
      expect((await payRows('void')).map((p) => p.id)).toEqual([first.id]);
    });

    it('se o provedor está fora, nada muda', async () => {
      await confirmed();
      provider.failCancel = true;

      await rejects(service.reopenOrder(userId), /provedor indisponível/);

      expect((await orderRow()).status).toBe('paying');
      expect(await payRows('void')).toHaveLength(0);
    });

    it('cancelar encerra o pedido e o próximo uso começa um pedido novo', async () => {
      await confirmed();
      const cancelledOrder = await orderRow();

      expect((await service.cancelOrder(userId)).status).toBe('cancelled');
      await service.addParticipant(userId, 'Ana');

      const next = await orderRow();
      expect(next.id).not.toBe(cancelledOrder.id);
      expect(next.status).toBe('collecting');
    });

    it('cancelar um pedido em montagem não chama o provedor', async () => {
      await service.addParticipant(userId, 'Ana');
      await service.cancelOrder(userId);
      expect(provider.cancelled).toHaveLength(0);
      expect((await orderRow()).status).toBe('cancelled');
    });

    it('depois que todos pagam o pedido fica pago; finalizar o encerra', async () => {
      await confirmed();
      expect(await service.hasPaidOrder(userId)).toBe(false);
      await rejects(
        service.markFinalized(userId),
        /Não há pedido totalmente pago/,
      );

      const [ana, bia] = await payRows('pending');
      await markPaid(ana.id, 3375);
      expect(await service.hasPaidOrder(userId)).toBe(false);
      const last = await markPaid(bia.id, 1125);
      expect(last?.orderPaid).toBe(true);

      expect(await service.hasPaidOrder(userId)).toBe(true);
      const view = await service.getOrderView(userId);
      expect(view.awaiting_finalization).toHaveLength(1);

      const done = await service.markFinalized(userId);
      expect(done.status).toBe('completed');
      expect(await service.hasPaidOrder(userId)).toBe(false);
    });

    it('depois de totalmente pago, reabrir e cancelar explicam que não dá mais', async () => {
      await confirmed();
      for (const p of await payRows('pending')) {
        await markPaid(p.id, Math.round(Number(p.amount) * 100));
      }

      await rejects(service.reopenOrder(userId), /totalmente pago/);
      await rejects(service.cancelOrder(userId), /totalmente pago/);
      expect((await orderRow()).status).toBe('paid');
    });

    it('com mais de um pedido pago, finalizar exige o order_id', async () => {
      // primeiro pedido, pago
      await confirmed();
      for (const p of await payRows('pending'))
        await markPaid(p.id, Math.round(Number(p.amount) * 100));
      const firstOrder = await orderRow();
      // segundo pedido, pago
      await setup(['Ana', 'Bia']);
      await service.syncCart(userId, pizzaria());
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'pizza',
        participantName: 'Ana',
      });
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'refri',
        participantName: 'Bia',
      });
      await service.confirmOrder(userId);
      for (const p of await payRows('pending'))
        await markPaid(p.id, Math.round(Number(p.amount) * 100));

      await rejects(service.markFinalized(userId), /mais de um pedido pago/);
      await rejects(
        service.markFinalized(userId, 999_999_999),
        /não está aguardando finalização/,
      );
      expect(
        (await service.markFinalized(userId, firstOrder.id)).order_id,
      ).toBe(firstOrder.id);
      expect(await service.hasPaidOrder(userId)).toBe(true); // o outro continua pago
    });
  });

  describe('visão do pedido', () => {
    it('sem pedido, explica; em montagem, mostra a prévia dos valores e os problemas', async () => {
      expect((await service.getOrderView(userId)).order).toBeNull();

      await setup(['Ana', 'Bia']);
      await service.syncCart(userId, pizzaria());
      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'pizza',
        participantName: 'Ana',
      });
      let view = await service.getOrderView(userId);
      expect(view.problems?.join()).toContain('Itens sem pagador: Refri');
      expect(view.amounts_preview).toBeUndefined();

      await service.assignPayer(userId, {
        ifoodCartId: 'cart-pizza',
        itemId: 'refri',
        participantName: 'Bia',
      });
      view = await service.getOrderView(userId);
      expect(view.problems).toEqual([]);
      expect(view.amounts_preview).toEqual([
        {
          cart: 'Pizzaria',
          participant: 'Ana',
          items: 'R$ 30,00',
          fees_share: 'R$ 3,75',
          total: 'R$ 33,75',
        },
        {
          cart: 'Pizzaria',
          participant: 'Bia',
          items: 'R$ 10,00',
          fees_share: 'R$ 1,25',
          total: 'R$ 11,25',
        },
      ]);
    });

    it('openIfoodCartIds lista só os carrinhos de pedidos ainda não pagos', async () => {
      await setup(['Ana']);
      await service.syncCart(userId, burger());
      expect(await service.openIfoodCartIds(userId)).toEqual(['cart-burger']);
    });
  });

  it('GroupOrderError é o erro de negócio esperado', () => {
    expect(new GroupOrderError('x')).toBeInstanceOf(Error);
  });
});
