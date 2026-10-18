import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { chats, type ChatChannel } from '../db/schema.js';

export interface ChatAddress {
  channel: ChatChannel;
  externalId: string;
}

// Traduz o id do chat no canal (Telegram, WhatsApp) para o chatId interno (chats.id) e de volta.
// O par nunca muda depois de criado, então os dois sentidos ficam em cache.
@Injectable()
export class ChatsService {
  private readonly ids = new Map<string, number>();
  private readonly addresses = new Map<number, ChatAddress>();

  constructor(private readonly database: DbService) {}

  private get db() {
    return this.database.db;
  }

  async resolve(channel: ChatChannel, externalId: string): Promise<number> {
    const key = `${channel}:${externalId}`;
    const cached = this.ids.get(key);
    if (cached !== undefined) return cached;

    // onConflictDoNothing cobre duas mensagens do mesmo chat chegando juntas.
    await this.db
      .insert(chats)
      .values({ channel, externalId })
      .onConflictDoNothing({ target: [chats.channel, chats.externalId] });
    const [row] = await this.db
      .select({ id: chats.id })
      .from(chats)
      .where(and(eq(chats.channel, channel), eq(chats.externalId, externalId)));
    this.remember(row.id, { channel, externalId });
    return row.id;
  }

  async address(chatId: number): Promise<ChatAddress | undefined> {
    const cached = this.addresses.get(chatId);
    if (cached) return cached;
    const [row] = await this.db
      .select({ channel: chats.channel, externalId: chats.externalId })
      .from(chats)
      .where(eq(chats.id, chatId));
    if (!row) return undefined;
    this.remember(chatId, row);
    return row;
  }

  private remember(chatId: number, address: ChatAddress): void {
    this.ids.set(`${address.channel}:${address.externalId}`, chatId);
    this.addresses.set(chatId, address);
  }
}
