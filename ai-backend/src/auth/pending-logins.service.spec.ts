import { randomBytes } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { oauthPendingLogins } from '../db/schema.js';
import { TokenCipher } from '../users/token-cipher.js';
import {
  PENDING_LOGIN_TTL_MS,
  PendingLoginsService,
} from './pending-logins.service.js';

// Roda contra um Postgres real:  TEST_DATABASE_URL=... npm test
describe.skipIf(!process.env.TEST_DATABASE_URL)('PendingLoginsService', () => {
  const PREFIX = `t${Date.now()}-`;
  let database: DbService;
  let service: PendingLoginsService;
  let seq = 0;
  const state = () => `${PREFIX}${++seq}`;

  beforeAll(() => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    database = new DbService();
    service = new PendingLoginsService(database, new TokenCipher());
  });

  afterAll(async () => {
    await database.db
      .delete(oauthPendingLogins)
      .where(like(oauthPendingLogins.state, `${PREFIX}%`));
    await database.onModuleDestroy();
  });

  it('guarda o login (verifier cifrado) e devolve na volta', async () => {
    const s = state();
    await service.save(s, {
      chatId: 42,
      codeVerifier: 'verifier-super-secreto',
    });

    const [row] = await database.db
      .select()
      .from(oauthPendingLogins)
      .where(eq(oauthPendingLogins.state, s));
    expect(row.chatId).toBe(42);
    expect(row.codeVerifierEnc).toMatch(/^v1:/);
    expect(row.codeVerifierEnc).not.toContain('verifier-super-secreto');

    expect(await service.consume(s)).toEqual({
      chatId: 42,
      codeVerifier: 'verifier-super-secreto',
    });
  });

  it('é de uso único, também com acessos simultâneos ao callback', async () => {
    const s = state();
    await service.save(s, { chatId: 7, codeVerifier: 'v' });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.consume(s)),
    );

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await service.consume(s)).toBeNull();
  });

  it('state desconhecido, expirado ou adulterado devolve null', async () => {
    expect(await service.consume(state())).toBeNull();

    const expired = state();
    await service.save(expired, { chatId: 1, codeVerifier: 'v' });
    await database.db
      .update(oauthPendingLogins)
      .set({ createdAt: new Date(Date.now() - PENDING_LOGIN_TTL_MS - 1000) })
      .where(eq(oauthPendingLogins.state, expired));
    expect(await service.consume(expired)).toBeNull();

    const tampered = state();
    await service.save(tampered, { chatId: 1, codeVerifier: 'v' });
    const other = state();
    await service.save(other, { chatId: 1, codeVerifier: 'outro' });
    const [otherRow] = await database.db
      .select()
      .from(oauthPendingLogins)
      .where(eq(oauthPendingLogins.state, other));
    // verifier de outro state colado neste: amarrado ao state, não decifra
    await database.db
      .update(oauthPendingLogins)
      .set({ codeVerifierEnc: otherRow.codeVerifierEnc })
      .where(eq(oauthPendingLogins.state, tampered));
    expect(await service.consume(tampered)).toBeNull();
  });

  it('salvar limpa os logins que já expiraram', async () => {
    const old = state();
    await service.save(old, { chatId: 1, codeVerifier: 'v' });
    await database.db
      .update(oauthPendingLogins)
      .set({ createdAt: new Date(Date.now() - PENDING_LOGIN_TTL_MS - 1000) })
      .where(eq(oauthPendingLogins.state, old));

    await service.save(state(), { chatId: 1, codeVerifier: 'v' });

    const rows = await database.db
      .select()
      .from(oauthPendingLogins)
      .where(eq(oauthPendingLogins.state, old));
    expect(rows).toHaveLength(0);
  });
});
