import { inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { chats } from '../db/schema.js';
import { resetAppConfig } from '../config/app-config.js';
import { ChatsService } from './chats.service.js';

// Banco simulado: só conta as idas ao banco e devolve as linhas pedidas.
function fakeDatabase(selectRows: unknown[][]) {
  const insert = vi.fn(() => ({
    values: () => ({ onConflictDoNothing: () => Promise.resolve() }),
  }));
  const select = vi.fn(() => ({
    from: () => ({ where: () => Promise.resolve(selectRows.shift() ?? []) }),
  }));
  return { database: { db: { insert, select } }, insert, select };
}

describe('ChatsService (cache)', () => {
  it('resolve cria o chat uma vez e depois responde do cache, nos dois sentidos', async () => {
    const { database, insert, select } = fakeDatabase([[{ id: 7 }]]);
    const service = new ChatsService(database as unknown as DbService);

    expect(await service.resolve('whatsapp', '5511999999999')).toBe(7);
    expect(await service.resolve('whatsapp', '5511999999999')).toBe(7);
    expect(await service.address(7)).toEqual({
      channel: 'whatsapp',
      externalId: '5511999999999',
    });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('address busca no banco quando não está no cache e devolve undefined se não existe', async () => {
    const { database, select } = fakeDatabase([
      [{ channel: 'telegram', externalId: '99' }],
      [],
    ]);
    const service = new ChatsService(database as unknown as DbService);

    expect(await service.address(3)).toEqual({
      channel: 'telegram',
      externalId: '99',
    });
    expect(await service.address(3)).toEqual({
      channel: 'telegram',
      externalId: '99',
    });
    expect(await service.address(4)).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(2);
  });
});

// Roda contra um Postgres real:  TEST_DATABASE_URL=... npm test
describe.skipIf(!process.env.TEST_DATABASE_URL)('ChatsService (banco)', () => {
  const EXTERNAL = `teste-${Date.now()}-${Math.random()}`;
  let database: DbService;

  beforeAll(() => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    resetAppConfig();
    database = new DbService();
  });

  afterAll(async () => {
    await database.db
      .delete(chats)
      .where(inArray(chats.externalId, [EXTERNAL]));
    await database.onModuleDestroy();
  });

  it('o mesmo id externo vira o mesmo chatId, inclusive em chamadas simultâneas', async () => {
    const [a, b] = await Promise.all([
      new ChatsService(database).resolve('whatsapp', EXTERNAL),
      new ChatsService(database).resolve('whatsapp', EXTERNAL),
    ]);
    expect(a).toBe(b);

    const fresh = new ChatsService(database);
    expect(await fresh.address(a)).toEqual({
      channel: 'whatsapp',
      externalId: EXTERNAL,
    });
    expect(await fresh.resolve('telegram', EXTERNAL)).not.toBe(a);
  });
});
