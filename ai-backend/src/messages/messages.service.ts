import { Injectable } from '@nestjs/common';
import { asc, count, eq } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { chatFacts, messages } from '../db/schema.js';

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export interface SeenFacts {
  ids: string[];
  cents: number[];
}

// Linhas por INSERT no registro de fatos (bem abaixo do limite de parâmetros do Postgres).
const FACTS_CHUNK = 5000;

// Onde começa a janela de histórico: no máximo `rows` linhas a mais que o mínimo, e o começo só
// anda de `step` em `step` linhas. Entre um salto e outro, o começo da conversa enviada ao LLM não
// muda e o prompt cache o reaproveita.
export function windowStart(total: number, rows: number, step = 1): number {
  return Math.max(0, Math.floor((total - rows) / step) * step);
}

@Injectable()
export class MessagesService {
  constructor(private readonly database: DbService) {}

  private get db() {
    return this.database.db;
  }

  async add(message: NewMessage): Promise<number> {
    const [row] = await this.db
      .insert(messages)
      .values(message)
      .returning({ id: messages.id });
    return row.id;
  }

  // Um único INSERT (tudo ou nada), na ordem recebida: uma conversa nunca fica com tool_use sem tool_result.
  async addMany(rows: NewMessage[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(messages).values(rows);
  }

  // Blocos de uma mensagem já gravada (ex.: o estado do pedido junto da mensagem do usuário).
  async setPayload(id: number, payload: unknown): Promise<void> {
    await this.db.update(messages).set({ payload }).where(eq(messages.id, id));
  }

  // As mensagens recentes do chat (pelo menos `limit`, ver windowStart), da mais antiga para a
  // mais nova. Ordena por id: linhas gravadas na mesma transação compartilham o created_at.
  async recent(chatId: number, limit: number, step = 1): Promise<Message[]> {
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(messages)
      .where(eq(messages.chatId, chatId));
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(asc(messages.id))
      .offset(windowStart(total, limit, step));
  }

  async seenFacts(chatId: number): Promise<SeenFacts> {
    const rows = await this.db
      .select({ kind: chatFacts.kind, value: chatFacts.value })
      .from(chatFacts)
      .where(eq(chatFacts.chatId, chatId));
    return {
      ids: rows.filter((r) => r.kind === 'id').map((r) => r.value),
      cents: rows.filter((r) => r.kind === 'cents').map((r) => Number(r.value)),
    };
  }

  async rememberFacts(chatId: number, facts: SeenFacts): Promise<void> {
    const rows = [
      ...facts.ids.map((value) => ({ chatId, kind: 'id' as const, value })),
      ...facts.cents.map((c) => ({
        chatId,
        kind: 'cents' as const,
        value: String(c),
      })),
    ];
    for (let i = 0; i < rows.length; i += FACTS_CHUNK) {
      await this.db
        .insert(chatFacts)
        .values(rows.slice(i, i + FACTS_CHUNK))
        .onConflictDoNothing();
    }
  }

  async clearChat(chatId: number): Promise<void> {
    await this.db.delete(messages).where(eq(messages.chatId, chatId));
    await this.db.delete(chatFacts).where(eq(chatFacts.chatId, chatId));
  }
}
