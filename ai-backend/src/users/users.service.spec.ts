import { randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { users } from '../db/schema.js';
import { TokenCipher } from './token-cipher.js';
import { UsersService } from './users.service.js';
import { resetAppConfig } from '../config/app-config.js';

// Roda contra um Postgres real:  TEST_DATABASE_URL=... npm test
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'UsersService (tokens cifrados)',
  () => {
    const BASE = 3_000_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
    const KEY = randomBytes(32).toString('base64');
    const chats: number[] = [];
    let database: DbService;
    let service: UsersService;
    let seq = 0;

    const newChat = () => {
      const chat = BASE + ++seq;
      chats.push(chat);
      return chat;
    };
    const rawRow = async (chat: number) =>
      (
        await database.db
          .select()
          .from(users)
          .where(eq(users.telegramChatId, chat))
      )[0];
    const tokens = (suffix = '') => ({
      accessToken: `eyJhbGciOiJSUzI1NiJ9.acesso-secreto${suffix}.sig`,
      refreshToken: `eyJhbGciOiJSUzI1NiJ9.refresh-secreto${suffix}.sig`,
      expiresAt: new Date(Date.now() + 3600_000),
    });

    beforeAll(() => {
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
      process.env.TOKEN_ENCRYPTION_KEY = KEY;
      resetAppConfig();
      database = new DbService();
      service = new UsersService(database, new TokenCipher());
    });

    afterAll(async () => {
      await database.db
        .delete(users)
        .where(inArray(users.telegramChatId, chats));
      await database.onModuleDestroy();
    });

    it('no banco os tokens ficam cifrados, e ao ler voltam em texto puro para uso normal', async () => {
      const chat = newChat();
      const saved = tokens();

      await service.saveIfoodTokens(chat, saved);

      const row = await rawRow(chat);
      expect(row.ifoodToken).toMatch(/^v1:/);
      expect(row.ifoodRefreshToken).toMatch(/^v1:/);
      expect(row.ifoodToken).not.toContain('acesso-secreto');
      expect(row.ifoodRefreshToken).not.toContain('refresh-secreto');
      expect(await service.getIfoodTokens(chat)).toEqual(saved);
    });

    it('atualizar (refresh rotaciona os tokens) regrava cifrado; limpar apaga', async () => {
      const chat = newChat();
      await service.saveIfoodTokens(chat, tokens('-1'));
      const first = (await rawRow(chat)).ifoodToken;

      const second = tokens('-2');
      await service.saveIfoodTokens(chat, second);

      expect((await rawRow(chat)).ifoodToken).not.toBe(first);
      expect(await service.getIfoodTokens(chat)).toEqual(second);

      await service.clearIfoodTokens(chat);
      expect(await service.getIfoodTokens(chat)).toBeNull();
      expect((await rawRow(chat)).ifoodToken).toBeNull();
    });

    it('valor cifrado copiado para outro usuário não funciona (amarrado ao usuário e à coluna)', async () => {
      const victim = newChat();
      const attacker = newChat();
      await service.saveIfoodTokens(victim, tokens('-v'));
      await service.saveIfoodTokens(attacker, tokens('-a'));
      const stolen = await rawRow(victim);

      await database.db
        .update(users)
        .set({
          ifoodToken: stolen.ifoodToken,
          ifoodRefreshToken: stolen.ifoodRefreshToken,
        })
        .where(eq(users.telegramChatId, attacker));

      expect(await service.getIfoodTokens(attacker)).toBeNull();
    });

    it('com a chave trocada ou dado adulterado, trata como deslogado em vez de quebrar', async () => {
      const chat = newChat();
      await service.saveIfoodTokens(chat, tokens());

      process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
      resetAppConfig();
      const otherKey = new UsersService(database, new TokenCipher());
      expect(await otherKey.getIfoodTokens(chat)).toBeNull();
      process.env.TOKEN_ENCRYPTION_KEY = KEY;
      resetAppConfig();

      const row = await rawRow(chat);
      await database.db
        .update(users)
        .set({ ifoodToken: `${row.ifoodToken!.slice(0, -2)}AA` })
        .where(eq(users.telegramChatId, chat));
      expect(await service.getIfoodTokens(chat)).toBeNull();
    });

    it('tokens antigos em texto puro continuam valendo e são cifrados na migração', async () => {
      const chat = newChat();
      const legacy = tokens('-legado');
      await database.db.insert(users).values({
        name: 'Legado',
        telegramChatId: chat,
        ifoodToken: legacy.accessToken,
        ifoodRefreshToken: legacy.refreshToken,
        tokenExpiresAt: legacy.expiresAt,
      });

      // antes da migração: o usuário continua logado
      expect(await service.getIfoodTokens(chat)).toEqual(legacy);

      expect(await service.encryptLegacyTokens()).toBeGreaterThanOrEqual(1);

      const row = await rawRow(chat);
      expect(row.ifoodToken).toMatch(/^v1:/);
      expect(row.ifoodRefreshToken).toMatch(/^v1:/);
      expect(row.ifoodToken).not.toContain('acesso-secreto');
      expect(await service.getIfoodTokens(chat)).toEqual(legacy);
      // idempotente
      const again = await service.encryptLegacyTokens();
      expect((await rawRow(chat)).ifoodToken).toBe(row.ifoodToken);
      expect(again).toBe(0);
    });
  },
);
