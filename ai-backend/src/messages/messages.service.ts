import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { messages } from '../db/schema.js';

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

@Injectable()
export class MessagesService {
  constructor(private readonly database: DbService) {}

  private get db() {
    return this.database.db;
  }

  async add(message: NewMessage): Promise<void> {
    await this.db.insert(messages).values(message);
  }

  // Um único INSERT (tudo ou nada), na ordem recebida: uma conversa nunca fica com tool_use sem tool_result.
  async addMany(rows: NewMessage[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(messages).values(rows);
  }

  // As últimas `limit` mensagens do chat, da mais antiga para a mais nova.
  // Ordena por id: linhas gravadas na mesma transação compartilham o created_at.
  async recent(chatId: number, limit: number): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.id))
      .limit(limit);
    return rows.reverse();
  }

  async clearChat(chatId: number): Promise<void> {
    await this.db.delete(messages).where(eq(messages.chatId, chatId));
  }
}
