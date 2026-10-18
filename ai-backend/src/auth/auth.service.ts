import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { UsersService } from '../users/users.service.js';
import { PendingLoginsService } from './pending-logins.service.js';

// Servidor de autenticação do iFood. A documentação cita id.ifood.com.br (página Implementation)
// e auth.ifood.com.br / dev-auth.ifood.com.br (índice llms.txt): configurável por IFOOD_AUTH_BASE_URL.
const authUrl = (path: string) =>
  `${(process.env.IFOOD_AUTH_BASE_URL ?? 'https://id.ifood.com.br').replace(/\/+$/, '')}/${path}`;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
// Sem mcp.cart.payment (consulta de meios de pagamento) por enquanto.
const DEFAULT_SCOPES = [
  'mcp.user.basic.read',
  'mcp.user.advanced.read',
  'mcp.user.addresses.read',
  'mcp.user.behavior.read',
  'mcp.user.addresses.write',
  'mcp.discovery',
  'mcp.discovery.search.read',
  'mcp.discovery.browse.read',
  'mcp.discovery.recommendation.read',
  'mcp.discovery.details.read',
  'mcp.cart',
  'mcp.cart.read',
  'mcp.cart.write',
  'mcp.cart.checkout',
  'mcp.orders.read',
].join(' ');

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

type LoginListener = (chatId: number) => void | Promise<void>;

export function createCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly loginListeners: LoginListener[] = [];

  // Tokens (cifrados) e logins em andamento ficam no banco: reiniciar o back não desloga ninguém
  // nem invalida o link de login que acabou de ser enviado.
  constructor(
    private readonly users: UsersService,
    private readonly pending: PendingLoginsService,
  ) {}

  private get config() {
    return {
      clientId: process.env.IFOOD_CLIENT_ID ?? '',
      clientSecret: process.env.IFOOD_CLIENT_SECRET ?? '',
      redirectUri:
        process.env.IFOOD_REDIRECT_URI ?? 'http://localhost:3000/redirect',
      scopes: process.env.IFOOD_SCOPES ?? DEFAULT_SCOPES,
    };
  }

  onLogin(listener: LoginListener): void {
    this.loginListeners.push(listener);
  }

  async buildLoginUrl(chatId: number): Promise<string> {
    const codeVerifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    await this.pending.save(state, { chatId, codeVerifier });

    const { clientId, redirectUri, scopes } = this.config;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes,
      state,
      code_challenge: createCodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    this.logger.log(
      `[login] link gerado para o chat ${chatId} (state=${state}, redirect_uri=${redirectUri})`,
    );
    return `${authUrl('authorize')}?${params.toString()}`;
  }

  async handleCallback(code: string, state: string): Promise<number> {
    const pending = await this.pending.consume(state);
    if (!pending) {
      this.logger.warn(
        `[callback] state ${state} desconhecido, expirado ou já usado`,
      );
      throw new ForbiddenException('State inválido ou expirado.');
    }

    this.logger.log(
      `[callback] state válido para o chat ${pending.chatId}, trocando code por tokens...`,
    );
    const { clientId, clientSecret, redirectUri } = this.config;
    const tokens = await this.requestTokens({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: pending.codeVerifier,
    });
    await this.saveTokens(pending.chatId, tokens);
    this.logger.log(
      `[callback] tokens recebidos e salvos para o chat ${pending.chatId} (expira em ${tokens.expires_in}s)`,
    );

    for (const listener of this.loginListeners) {
      try {
        await listener(pending.chatId);
      } catch (err) {
        this.logger.error(`Falha em listener de login: ${String(err)}`);
      }
    }
    return pending.chatId;
  }

  async getValidAccessToken(chatId: number): Promise<string | null> {
    const current = await this.users.getIfoodTokens(chatId);
    if (!current) {
      this.logger.log(`[token] chat ${chatId} sem token — precisa logar`);
      return null;
    }
    const remainingMs = current.expiresAt.getTime() - Date.now();
    if (remainingMs > REFRESH_BUFFER_MS) {
      this.logger.log(
        `[token] chat ${chatId} com token válido (${Math.round(remainingMs / 1000)}s restantes)`,
      );
      return current.accessToken;
    }

    this.logger.log(
      `[token] token do chat ${chatId} perto de expirar, renovando...`,
    );
    try {
      const { clientId, clientSecret } = this.config;
      const tokens = await this.requestTokens({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      });
      // Tokens rotacionam a cada refresh: descarta o par anterior.
      await this.saveTokens(chatId, tokens);
      this.logger.log(`[token] token do chat ${chatId} renovado`);
      return tokens.access_token;
    } catch (err) {
      this.logger.warn(`Refresh falhou para o chat ${chatId}: ${String(err)}`);
      await this.users.clearIfoodTokens(chatId);
      return null;
    }
  }

  async invalidate(chatId: number): Promise<void> {
    this.logger.warn(`[token] token do chat ${chatId} invalidado`);
    await this.users.clearIfoodTokens(chatId);
  }

  async logout(chatId: number): Promise<void> {
    const current = await this.users.getIfoodTokens(chatId);
    await this.users.clearIfoodTokens(chatId);
    if (!current) return;

    this.logger.log(`[logout] revogando token do chat ${chatId}`);
    const { clientId, clientSecret } = this.config;
    const response = await fetch(authUrl('revoke'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: current.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!response.ok)
      this.logger.warn(
        `Revoke retornou ${response.status} para o chat ${chatId}`,
      );
  }

  private async requestTokens(
    body: Record<string, string>,
  ): Promise<TokenResponse> {
    const response = await fetch(authUrl('token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    this.logger.log(
      `[token-endpoint] ${body.grant_type} → HTTP ${response.status}`,
    );
    if (!response.ok) {
      throw new Error(
        `Token endpoint retornou ${response.status}: ${await response.text()}`,
      );
    }
    return (await response.json()) as TokenResponse;
  }

  private saveTokens(chatId: number, tokens: TokenResponse): Promise<void> {
    return this.users.saveIfoodTokens(chatId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    });
  }
}
