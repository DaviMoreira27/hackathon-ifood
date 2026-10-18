import { eq, inArray } from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import { TurnTracesService } from '../agent/turn-traces.service.js';
import { DEFAULT_AGENT_CONFIG } from '../agent/agent.config.js';
import { AgentService } from '../agent/agent.service.js';
import { wrapToolResult } from '../agent/tool-policy.js';
import type { AuthService } from '../auth/auth.service.js';
import type { McpService } from '../mcp/mcp.service.js';
import { GroupOrderService } from '../group-order/group-order.service.js';
import { GroupOrderTools } from '../group-order/group-order.tools.js';
import { DietaryService } from '../dietary/dietary.service.js';
import { DietaryTools } from '../dietary/dietary.tools.js';
import { PaymentProviderClient } from '../payments/payment-provider.client.js';
import { PaymentsService } from '../payments/payments.service.js';
import { CartsService } from '../carts/carts.service.js';
import { MessagesService } from '../messages/messages.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { TokenCipher } from '../users/token-cipher.js';
import { UsersService } from '../users/users.service.js';
import { DbService } from './db.service.js';
import { messages, orders, users } from './schema.js';

// Roda contra um Postgres real (schema de db/init.sql). Exemplo:
//   TEST_DATABASE_URL=postgresql://ifood:ifood@localhost:5433/ifood npm test
// Usa chat ids altos e aleatórios e apaga o que cria; os dados de seed não são tocados.
describe.skipIf(!process.env.TEST_DATABASE_URL)('banco (integração)', () => {
  const CHAT = 8_000_000_000 + Math.floor(Math.random() * 1_000_000);
  let database: DbService;
  let usersService: UsersService;
  let messagesService: MessagesService;
  let ordersService: OrdersService;
  let cartsService: CartsService;

  beforeAll(() => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    database = new DbService();
    process.env.TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(43) + '=';
    usersService = new UsersService(database, new TokenCipher());
    messagesService = new MessagesService(database);
    ordersService = new OrdersService(database);
    cartsService = new CartsService(database);
  });

  afterAll(async () => {
    const { db } = database;
    const owned = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.telegramChatId, [CHAT, CHAT + 1]));
    const ids = owned.map((u) => u.id);
    await db.delete(messages).where(inArray(messages.chatId, [CHAT, CHAT + 1]));
    if (ids.length) {
      await db.delete(orders).where(inArray(orders.ownerUserId, ids)); // carts caem em cascata
      await db.delete(users).where(inArray(users.id, ids));
    }
    await database.onModuleDestroy();
  });

  it('getOrCreateByTelegram é idempotente, inclusive com chamadas simultâneas', async () => {
    const [a, b] = await Promise.all([
      usersService.getOrCreateByTelegram(CHAT, 'Davi'),
      usersService.getOrCreateByTelegram(CHAT, 'Davi'),
    ]);
    const again = await usersService.getOrCreateByTelegram(CHAT, 'Outro Nome');

    expect(a.id).toBe(b.id);
    expect(again.id).toBe(a.id);
    expect(again.name).toBe('Davi');
    expect(again.email).toBeNull();
  });

  it('guarda, lê e apaga os tokens do iFood', async () => {
    expect(await usersService.getIfoodTokens(CHAT)).toBeNull();

    const expiresAt = new Date(Date.now() + 3600_000);
    await usersService.saveIfoodTokens(CHAT, {
      accessToken: 'a1',
      refreshToken: 'r1',
      expiresAt,
    });
    await usersService.saveIfoodTokens(CHAT, {
      accessToken: 'a2',
      refreshToken: 'r2',
      expiresAt,
    });
    expect(await usersService.getIfoodTokens(CHAT)).toEqual({
      accessToken: 'a2',
      refreshToken: 'r2',
      expiresAt,
    });

    await usersService.clearIfoodTokens(CHAT);
    expect(await usersService.getIfoodTokens(CHAT)).toBeNull();
  });

  it('saveIfoodTokens cria o usuário se ele ainda não existe', async () => {
    await usersService.saveIfoodTokens(CHAT + 1, {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 1000),
    });
    const user = await usersService.findByTelegramChatId(CHAT + 1);
    expect(user?.name).toBe(`Telegram ${CHAT + 1}`);
  });

  it('mensagens: mantém a ordem, a janela e o payload jsonb', async () => {
    const user = (await usersService.findByTelegramChatId(CHAT))!;
    const toolUse = [
      { type: 'tool_use', id: 'x', name: 'search', input: { q: 1 } },
    ];

    await messagesService.add({
      chatId: CHAT,
      userId: user.id,
      role: 'user',
      content: 'oi',
    });
    await messagesService.addMany([
      {
        chatId: CHAT,
        userId: user.id,
        role: 'assistant',
        content: 't',
        payload: toolUse,
      },
      { chatId: CHAT, userId: user.id, role: 'tool', content: 'r' },
      { chatId: CHAT, userId: user.id, role: 'assistant', content: 'fim' },
    ]);

    const all = await messagesService.recent(CHAT, 10);
    expect(all.map((m) => m.content)).toEqual(['oi', 't', 'r', 'fim']);
    expect(all[1].payload).toEqual(toolUse);
    expect(all[0].payload).toBeNull();

    const last2 = await messagesService.recent(CHAT, 2);
    expect(last2.map((m) => m.content)).toEqual(['r', 'fim']);
  });

  it('addMany é tudo ou nada', async () => {
    const before = (await messagesService.recent(CHAT, 100)).length;

    await expect(
      messagesService.addMany([
        { chatId: CHAT, role: 'user', content: 'entra?' },
        { chatId: CHAT, role: 'user', content: null as unknown as string },
      ]),
    ).rejects.toThrow();

    expect((await messagesService.recent(CHAT, 100)).length).toBe(before);
  });

  it('pedidos e carrinhos: cria, lista, muda status e cascateia', async () => {
    const user = (await usersService.findByTelegramChatId(CHAT))!;

    const order = await ordersService.create(user.id);
    expect(order.status).toBe('collecting');
    const cart = await cartsService.add({
      orderId: order.id,
      ifoodCartId: 'cart_test_1',
      subtotal: '42.90',
      total: '47.90',
    });
    expect(cart).toMatchObject({ subtotal: '42.90', status: 'pending' });

    await cartsService.setStatus(cart.id, 'confirmed');
    await ordersService.setStatus(order.id, 'confirmed');

    expect((await cartsService.listByOrder(order.id))[0].status).toBe(
      'confirmed',
    );
    expect((await ordersService.listByOwner(user.id))[0]).toMatchObject({
      id: order.id,
      status: 'confirmed',
    });

    await database.db.delete(orders).where(eq(orders.id, order.id));
    expect(await cartsService.listByOrder(order.id)).toEqual([]);
  });

  it('agent: o histórico com tool_use/tool_result volta íntegro do jsonb', async () => {
    const chat = CHAT + 1;
    const sent: Array<Array<{ role: string; content: any }>> = [];
    const replies = [
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'x' } },
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'achei' }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'feito' }] },
    ];
    const anthropic = {
      messages: {
        create: async (p: { messages: unknown }) => {
          sent.push(structuredClone(p.messages) as (typeof sent)[number]);
          return replies.shift();
        },
      },
    };
    const agent = new AgentService(
      anthropic as unknown as Anthropic,
      { getValidAccessToken: async () => 't' } as unknown as AuthService,
      {
        getSession: async () => ({
          tools: [{ name: 'search' }],
          confirmTools: new Set<string>(),
        }),
        callTool: async () => ({ text: '{"id":"item-9"}', isError: false }),
      } as unknown as McpService,
      usersService,
      messagesService,
      new GroupOrderTools(
        new GroupOrderService(
          database,
          new PaymentsService(database, new PaymentProviderClient()),
        ),
      ),
      new DietaryTools(new DietaryService(database)),
      new TurnTracesService(database),
      DEFAULT_AGENT_CONFIG,
    );

    expect(await agent.handle(chat, 'procura x', { name: 'Maria' })).toBe(
      'achei',
    );
    expect(await agent.handle(chat, 'adiciona')).toBe('feito');

    const third = sent[2];
    expect(third.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(third[1].content[0]).toMatchObject({
      type: 'tool_use',
      id: 'tu1',
      input: { q: 'x' },
    });
    expect(third[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu1',
      content: wrapToolResult('search', '{"id":"item-9"}'),
    });
    const rows = await messagesService.recent(chat, 20);
    expect(rows.map((r) => r.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(rows.every((r) => r.userId !== null)).toBe(true);
  });

  it('limpa a conversa de um chat sem tocar nos outros', async () => {
    await messagesService.add({
      chatId: CHAT + 1,
      role: 'user',
      content: 'outro',
    });

    const otherBefore = (await messagesService.recent(CHAT + 1, 100)).length;

    await messagesService.clearChat(CHAT);

    expect(await messagesService.recent(CHAT, 10)).toEqual([]);
    expect((await messagesService.recent(CHAT + 1, 100)).length).toBe(
      otherBefore,
    );
  });
});
