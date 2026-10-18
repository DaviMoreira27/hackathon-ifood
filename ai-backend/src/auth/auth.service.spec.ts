import { EventEmitter2 } from '@nestjs/event-emitter';
import { ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { IfoodTokens, UsersService } from '../users/users.service.js';
import { AuthService, createCodeChallenge } from './auth.service.js';
import type {
  PendingLogin,
  PendingLoginsService,
} from './pending-logins.service.js';
import { USER_LOGGED_IN } from '../common/events.js';
import { resetAppConfig } from '../config/app-config.js';

// UsersService em memória: o que importa aqui é o contrato de tokens, não o SQL.
class FakeUsers {
  tokens = new Map<number, IfoodTokens>();
  getIfoodTokens = async (chatId: number) => this.tokens.get(chatId) ?? null;
  saveIfoodTokens = async (chatId: number, t: IfoodTokens) => {
    this.tokens.set(chatId, t);
  };
  clearIfoodTokens = async (chatId: number) => {
    this.tokens.delete(chatId);
  };
}

// Logins pendentes em memória, com a mesma semântica de uso único do banco.
class FakePending {
  rows = new Map<string, PendingLogin>();
  save = async (state: string, login: PendingLogin) => {
    this.rows.set(state, login);
  };
  consume = async (state: string) => {
    const row = this.rows.get(state) ?? null;
    this.rows.delete(state);
    return row;
  };
}

const tokenResponse = (access: string, refresh: string, expiresIn = 3600) =>
  new Response(
    JSON.stringify({
      access_token: access,
      refresh_token: refresh,
      expires_in: expiresIn,
    }),
    { status: 200 },
  );

describe('AuthService', () => {
  let service: AuthService;
  let events: EventEmitter2;
  let users: FakeUsers;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    users = new FakeUsers();
    events = new EventEmitter2();
    service = new AuthService(
      users as unknown as UsersService,
      new FakePending() as unknown as PendingLoginsService,
      events,
    );
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('gera code_challenge como base64url(sha256(verifier))', () => {
    const expected = createHash('sha256').update('abc').digest('base64url');
    expect(createCodeChallenge('abc')).toBe(expected);
  });

  it('monta a URL de login com PKCE e state', async () => {
    const url = new URL(await service.buildLoginUrl(42));
    expect(url.origin + url.pathname).toBe('https://id.ifood.com.br/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')!.length).toBeGreaterThanOrEqual(8);
    expect(url.searchParams.get('code_verifier')).toBeNull();
  });

  it('o servidor de autenticação é configurável (IFOOD_AUTH_BASE_URL)', async () => {
    process.env.IFOOD_AUTH_BASE_URL = 'https://dev-auth.ifood.com.br/';
    resetAppConfig();
    try {
      const url = new URL(await service.buildLoginUrl(42));
      expect(url.origin + url.pathname).toBe(
        'https://dev-auth.ifood.com.br/authorize',
      );
    } finally {
      delete process.env.IFOOD_AUTH_BASE_URL;
      resetAppConfig();
    }
  });

  it('rejeita callback com state desconhecido', async () => {
    await expect(
      service.handleCallback('code', 'state-invalido'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('troca o code por tokens, envia o code_verifier e avisa os listeners', async () => {
    const listener = vi.fn();
    events.on(USER_LOGGED_IN, listener);
    const state = new URL(await service.buildLoginUrl(42)).searchParams.get(
      'state',
    )!;
    fetchMock.mockResolvedValueOnce(tokenResponse('access-1', 'refresh-1'));

    await expect(service.handleCallback('the-code', state)).resolves.toBe(42);

    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBeTruthy();
    expect(listener).toHaveBeenCalledWith({ chatId: 42 });
    await expect(service.getValidAccessToken(42)).resolves.toBe('access-1');
    expect(users.tokens.get(42)?.refreshToken).toBe('refresh-1');
    // state é de uso único
    await expect(
      service.handleCallback('the-code', state),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('faz refresh quando faltam menos de 5 minutos e rotaciona os tokens', async () => {
    const state = new URL(await service.buildLoginUrl(42)).searchParams.get(
      'state',
    )!;
    fetchMock.mockResolvedValueOnce(tokenResponse('access-1', 'refresh-1', 60));
    await service.handleCallback('code', state);

    fetchMock.mockResolvedValueOnce(tokenResponse('access-2', 'refresh-2'));
    await expect(service.getValidAccessToken(42)).resolves.toBe('access-2');

    const body = fetchMock.mock.calls[1][1].body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
  });

  it('retorna null e esquece o usuário se o refresh falhar', async () => {
    const state = new URL(await service.buildLoginUrl(42)).searchParams.get(
      'state',
    )!;
    fetchMock.mockResolvedValueOnce(tokenResponse('access-1', 'refresh-1', 60));
    await service.handleCallback('code', state);

    fetchMock.mockResolvedValueOnce(
      new Response('invalid_grant', { status: 400 }),
    );
    await expect(service.getValidAccessToken(42)).resolves.toBeNull();
    expect(users.tokens.has(42)).toBe(false);
  });

  it('logout apaga os tokens e revoga o refresh_token no iFood', async () => {
    const state = new URL(await service.buildLoginUrl(42)).searchParams.get(
      'state',
    )!;
    fetchMock.mockResolvedValueOnce(tokenResponse('access-1', 'refresh-1'));
    await service.handleCallback('code', state);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await service.logout(42);

    expect(users.tokens.has(42)).toBe(false);
    const body = fetchMock.mock.calls[1][1].body as URLSearchParams;
    expect(fetchMock.mock.calls[1][0]).toBe('https://id.ifood.com.br/revoke');
    expect(body.get('token')).toBe('refresh-1');
  });
});
