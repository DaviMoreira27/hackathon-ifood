import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

const AUTHORIZE_URL = 'https://id.ifood.com.br/authorize';
const TOKEN_URL = 'https://id.ifood.com.br/token';
const REVOKE_URL = 'https://id.ifood.com.br/revoke';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
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

interface PendingAuth {
  userId: string;
  codeVerifier: string;
  createdAt: number;
}

interface UserTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

type LoginListener = (userId: string) => void | Promise<void>;

export function createCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  // Tudo em memória enquanto não há banco: reiniciar o processo exige novo login.
  private readonly pending = new Map<string, PendingAuth>();
  private readonly tokens = new Map<string, UserTokens>();
  private readonly loginListeners: LoginListener[] = [];

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

  buildLoginUrl(userId: string): string {
    this.prunePending();

    const codeVerifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    this.pending.set(state, { userId, codeVerifier, createdAt: Date.now() });

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
      `[login] link gerado para usuário ${userId} (state=${state}, redirect_uri=${redirectUri})`,
    );
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async handleCallback(code: string, state: string): Promise<string> {
    const pending = this.pending.get(state);
    if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
      this.logger.warn(
        `[callback] state ${state} ${pending ? 'expirado' : 'desconhecido'} (o back reiniciou ou o link já foi usado?)`,
      );
      this.pending.delete(state);
      throw new ForbiddenException('State inválido ou expirado.');
    }
    this.pending.delete(state);

    this.logger.log(
      `[callback] state válido para usuário ${pending.userId}, trocando code por tokens...`,
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
    this.saveTokens(pending.userId, tokens);
    this.logger.log(
      `[callback] tokens recebidos para usuário ${pending.userId} (expira em ${tokens.expires_in}s)`,
    );

    for (const listener of this.loginListeners) {
      try {
        await listener(pending.userId);
      } catch (err) {
        this.logger.error(`Falha em listener de login: ${String(err)}`);
      }
    }
    return pending.userId;
  }

  async getValidAccessToken(userId: string): Promise<string | null> {
    const current = this.tokens.get(userId);
    if (!current) {
      this.logger.log(`[token] usuário ${userId} sem token — precisa logar`);
      return null;
    }
    const remainingMs = current.expiresAt - Date.now();
    if (remainingMs > REFRESH_BUFFER_MS) {
      this.logger.log(
        `[token] usuário ${userId} com token válido (${Math.round(remainingMs / 1000)}s restantes)`,
      );
      return current.accessToken;
    }

    this.logger.log(
      `[token] token de ${userId} perto de expirar, renovando...`,
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
      this.saveTokens(userId, tokens);
      this.logger.log(`[token] token de ${userId} renovado`);
      return tokens.access_token;
    } catch (err) {
      this.logger.warn(`Refresh falhou para ${userId}: ${String(err)}`);
      this.tokens.delete(userId);
      return null;
    }
  }

  invalidate(userId: string): void {
    this.logger.warn(`[token] token de ${userId} invalidado`);
    this.tokens.delete(userId);
  }

  async logout(userId: string): Promise<void> {
    const current = this.tokens.get(userId);
    this.tokens.delete(userId);
    if (!current) return;

    this.logger.log(`[logout] revogando token de ${userId}`);
    const { clientId, clientSecret } = this.config;
    const response = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: current.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!response.ok)
      this.logger.warn(`Revoke retornou ${response.status} para ${userId}`);
  }

  private async requestTokens(
    body: Record<string, string>,
  ): Promise<TokenResponse> {
    const response = await fetch(TOKEN_URL, {
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

  private saveTokens(userId: string, tokens: TokenResponse): void {
    this.tokens.set(userId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    });
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [state, entry] of this.pending) {
      if (now - entry.createdAt > PENDING_TTL_MS) this.pending.delete(state);
    }
  }
}
