import { Injectable } from '@nestjs/common';
import { eq, lt } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { oauthPendingLogins } from '../db/schema.js';
import { TokenCipher } from '../users/token-cipher.js';

export const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;

export interface PendingLogin {
  chatId: number;
  codeVerifier: string;
}

// Logins OAuth em andamento, no banco. O code_verifier do PKCE é segredo (quem o tem, junto com o
// code, troca por tokens), então fica cifrado e amarrado ao state.
@Injectable()
export class PendingLoginsService {
  constructor(
    private readonly database: DbService,
    private readonly cipher: TokenCipher,
  ) {}

  private get db() {
    return this.database.db;
  }

  async save(state: string, login: PendingLogin): Promise<void> {
    // Aproveita para limpar o que já expirou: a tabela nunca cresce sem limite.
    await this.db
      .delete(oauthPendingLogins)
      .where(
        lt(
          oauthPendingLogins.createdAt,
          new Date(Date.now() - PENDING_LOGIN_TTL_MS),
        ),
      );
    await this.db.insert(oauthPendingLogins).values({
      state,
      chatId: login.chatId,
      codeVerifierEnc: this.cipher.encrypt(login.codeVerifier, `pkce:${state}`),
    });
  }

  // Uso único: o DELETE ... RETURNING é atômico, então um state não vale duas vezes nem com dois
  // acessos simultâneos ao callback. Devolve null se não existe, expirou ou não decifra.
  async consume(state: string): Promise<PendingLogin | null> {
    const [row] = await this.db
      .delete(oauthPendingLogins)
      .where(eq(oauthPendingLogins.state, state))
      .returning();
    if (!row) return null;
    if (Date.now() - row.createdAt.getTime() > PENDING_LOGIN_TTL_MS)
      return null;
    try {
      return {
        chatId: row.chatId,
        codeVerifier: this.cipher.decrypt(row.codeVerifierEnc, `pkce:${state}`),
      };
    } catch {
      return null;
    }
  }
}
