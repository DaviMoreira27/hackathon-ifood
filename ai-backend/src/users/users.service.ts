import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { users } from '../db/schema.js';

export type User = typeof users.$inferSelect;

export interface IfoodTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

@Injectable()
export class UsersService {
  constructor(private readonly database: DbService) {}

  private get db() {
    return this.database.db;
  }

  async findByTelegramChatId(chatId: number): Promise<User | undefined> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.telegramChatId, chatId));
    return user;
  }

  async getOrCreateByTelegram(chatId: number, name?: string): Promise<User> {
    const existing = await this.findByTelegramChatId(chatId);
    if (existing) return existing;

    // onConflictDoNothing cobre duas mensagens do mesmo chat chegando juntas.
    await this.db
      .insert(users)
      .values({
        name: name?.trim() || `Telegram ${chatId}`,
        telegramChatId: chatId,
      })
      .onConflictDoNothing({ target: users.telegramChatId });
    return (await this.findByTelegramChatId(chatId))!;
  }

  async getIfoodTokens(chatId: number): Promise<IfoodTokens | null> {
    const user = await this.findByTelegramChatId(chatId);
    if (!user?.ifoodToken || !user.ifoodRefreshToken || !user.tokenExpiresAt) {
      return null;
    }
    return {
      accessToken: user.ifoodToken,
      refreshToken: user.ifoodRefreshToken,
      expiresAt: user.tokenExpiresAt,
    };
  }

  async saveIfoodTokens(chatId: number, tokens: IfoodTokens): Promise<void> {
    const columns = {
      ifoodToken: tokens.accessToken,
      ifoodRefreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.expiresAt,
    };
    await this.db
      .insert(users)
      .values({
        name: `Telegram ${chatId}`,
        telegramChatId: chatId,
        ...columns,
      })
      .onConflictDoUpdate({ target: users.telegramChatId, set: columns });
  }

  async clearIfoodTokens(chatId: number): Promise<void> {
    await this.db
      .update(users)
      .set({ ifoodToken: null, ifoodRefreshToken: null, tokenExpiresAt: null })
      .where(eq(users.telegramChatId, chatId));
  }
}
