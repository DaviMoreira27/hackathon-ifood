import { ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuthService, createCodeChallenge } from './auth.service.js';

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
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    service = new AuthService();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('gera code_challenge como base64url(sha256(verifier))', () => {
    const expected = createHash('sha256').update('abc').digest('base64url');
    expect(createCodeChallenge('abc')).toBe(expected);
  });

  it('monta a URL de login com PKCE e state', () => {
    const url = new URL(service.buildLoginUrl('42'));
    expect(url.origin + url.pathname).toBe('https://id.ifood.com.br/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')!.length).toBeGreaterThanOrEqual(8);
    expect(url.searchParams.get('code_verifier')).toBeNull();
  });

  it('rejeita callback com state desconhecido', async () => {
    await expect(
      service.handleCallback('code', 'state-invalido'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('troca o code por tokens, envia o code_verifier e avisa os listeners', async () => {
    const listener = vi.fn();
    service.onLogin(listener);
    const state = new URL(service.buildLoginUrl('42')).searchParams.get(
      'state',
    )!;
    fetchMock.mockResolvedValueOnce(tokenResponse('access-1', 'refresh-1'));

    await expect(service.handleCallback('the-code', state)).resolves.toBe('42');

    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBeTruthy();
    expect(listener).toHaveBeenCalledWith('42');
    await expect(service.getValidAccessToken('42')).resolves.toBe('access-1');
    // state é de uso único
    await expect(
      service.handleCallback('the-code', state),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('faz refresh quando faltam menos de 5 minutos e rotaciona os tokens', async () => {
    const state = new URL(service.buildLoginUrl('42')).searchParams.get(
      'state',
    )!;
    fetchMock.mockResolvedValueOnce(tokenResponse('access-1', 'refresh-1', 60));
    await service.handleCallback('code', state);

    fetchMock.mockResolvedValueOnce(tokenResponse('access-2', 'refresh-2'));
    await expect(service.getValidAccessToken('42')).resolves.toBe('access-2');

    const body = fetchMock.mock.calls[1][1].body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
  });

  it('retorna null e esquece o usuário se o refresh falhar', async () => {
    const state = new URL(service.buildLoginUrl('42')).searchParams.get(
      'state',
    )!;
    fetchMock.mockResolvedValueOnce(tokenResponse('access-1', 'refresh-1', 60));
    await service.handleCallback('code', state);

    fetchMock.mockResolvedValueOnce(
      new Response('invalid_grant', { status: 400 }),
    );
    await expect(service.getValidAccessToken('42')).resolves.toBeNull();
    await expect(service.getValidAccessToken('42')).resolves.toBeNull();
  });
});
