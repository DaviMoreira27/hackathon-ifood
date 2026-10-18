import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, isNotNull, notLike, or } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { users } from '../db/schema.js';
import { TokenCipher } from './token-cipher.js';

export type User = typeof users.$inferSelect;

export interface IfoodTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

type TokenField = 'access' | 'refresh';

// O contexto (AAD) amarra o segredo ao usuário e à coluna: copiar o valor cifrado para outra
// linha ou coluna do banco não funciona.
const contextOf = (chatId: number, field: TokenField) =>
  `ifood:${field}:${chatId}`;

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly database: DbService,
    private readonly cipher: TokenCipher,
  ) {}

  private get db() {
    return this.database.db;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.encryptLegacyTokens();
    } catch (err) {
      // Banco fora do ar no boot não derruba o app; tokens antigos continuam legíveis e a
      // migração roda no próximo boot.
      this.logger.error(`Não consegui cifrar tokens antigos: ${String(err)}`);
    }
  }

  // Tokens gravados antes da cifra existir (texto puro) são cifrados uma vez, no boot.
  async encryptLegacyTokens(): Promise<number> {
    const legacy = await this.db
      .select()
      .from(users)
      .where(
        and(
          isNotNull(users.chatId),
          or(
            and(isNotNull(users.ifoodToken), notLike(users.ifoodToken, 'v1:%')),
            and(
              isNotNull(users.ifoodRefreshToken),
              notLike(users.ifoodRefreshToken, 'v1:%'),
            ),
          ),
        ),
      );
    for (const user of legacy) {
      const chatId = user.chatId as number;
      await this.db
        .update(users)
        .set({
          ifoodToken: this.protect(user.ifoodToken, chatId, 'access'),
          ifoodRefreshToken: this.protect(
            user.ifoodRefreshToken,
            chatId,
            'refresh',
          ),
        })
        .where(eq(users.id, user.id));
    }
    if (legacy.length > 0) {
      this.logger.log(
        `${legacy.length} usuário(s) com tokens em texto puro foram cifrados`,
      );
    }
    return legacy.length;
  }

  async findByChatId(chatId: number): Promise<User | undefined> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.chatId, chatId));
    return user;
  }

  async getOrCreateByChat(chatId: number, name?: string): Promise<User> {
    const existing = await this.findByChatId(chatId);
    if (existing) return existing;

    // onConflictDoNothing cobre duas mensagens do mesmo chat chegando juntas.
    await this.db
      .insert(users)
      .values({
        name: name?.trim() || `Chat ${chatId}`,
        chatId,
      })
      .onConflictDoNothing({ target: users.chatId });
    return (await this.findByChatId(chatId))!;
  }

  // `loaded`: o usuário já lido pelo chamador (evita outra consulta).
  async getIfoodTokens(
    chatId: number,
    loaded?: User,
  ): Promise<IfoodTokens | null> {
    const user = loaded ?? (await this.findByChatId(chatId));
    if (!user?.ifoodToken || !user.ifoodRefreshToken || !user.tokenExpiresAt) {
      return null;
    }
    try {
      return {
        accessToken: this.reveal(user.ifoodToken, chatId, 'access'),
        refreshToken: this.reveal(user.ifoodRefreshToken, chatId, 'refresh'),
        expiresAt: user.tokenExpiresAt,
      };
    } catch (err) {
      // Chave trocada ou dado alterado: trata como "não logado" (o usuário entra de novo).
      this.logger.warn(
        `Tokens do chat ${chatId} não puderam ser decifrados — pedindo novo login: ${String(err)}`,
      );
      return null;
    }
  }

  async saveIfoodTokens(chatId: number, tokens: IfoodTokens): Promise<void> {
    const columns = {
      ifoodToken: this.protect(tokens.accessToken, chatId, 'access'),
      ifoodRefreshToken: this.protect(tokens.refreshToken, chatId, 'refresh'),
      tokenExpiresAt: tokens.expiresAt,
    };
    await this.db
      .insert(users)
      .values({
        name: `Chat ${chatId}`,
        chatId,
        ...columns,
      })
      .onConflictDoUpdate({ target: users.chatId, set: columns });
  }

  async clearIfoodTokens(chatId: number): Promise<void> {
    await this.db
      .update(users)
      .set({ ifoodToken: null, ifoodRefreshToken: null, tokenExpiresAt: null })
      .where(eq(users.chatId, chatId));
  }

  private protect(
    value: string | null,
    chatId: number,
    field: TokenField,
  ): string | null {
    if (value === null || this.cipher.isEncrypted(value)) return value;
    return this.cipher.encrypt(value, contextOf(chatId, field));
  }

  // Valor sem o prefixo "v1:" é token antigo em texto puro (ainda não migrado): continua valendo.
  private reveal(value: string, chatId: number, field: TokenField): string {
    return this.cipher.isEncrypted(value)
      ? this.cipher.decrypt(value, contextOf(chatId, field))
      : value;
  }
}
