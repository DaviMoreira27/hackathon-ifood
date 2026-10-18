import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { dietaryRestrictions } from '../db/schema.js';
import type { SavedRestriction } from './dietary.check.js';

export type NewRestriction = Omit<SavedRestriction, 'personKey' | 'personName'>;

@Injectable()
export class DietaryService {
  constructor(private readonly database: DbService) {}

  private get db() {
    return this.database.db;
  }

  async list(userId: number): Promise<SavedRestriction[]> {
    const rows = await this.db
      .select()
      .from(dietaryRestrictions)
      .where(eq(dietaryRestrictions.userId, userId))
      .orderBy(asc(dietaryRestrictions.personKey), asc(dietaryRestrictions.id));
    return rows.map((r) => ({
      personKey: r.personKey,
      personName: r.personName,
      kind: r.kind,
      label: r.label,
      category: r.category,
      customTerms: r.customTerms,
    }));
  }

  // Salvar de novo a mesma restrição da mesma pessoa atualiza (ex.: troca a categoria).
  async save(
    userId: number,
    person: { key: string; name: string | null },
    entries: NewRestriction[],
  ): Promise<void> {
    if (entries.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const e of entries) {
        const columns = {
          personName: person.name,
          label: e.label,
          category: e.category,
          customTerms: e.customTerms,
        };
        await tx
          .insert(dietaryRestrictions)
          .values({ userId, personKey: person.key, kind: e.kind, ...columns })
          .onConflictDoUpdate({
            target: [
              dietaryRestrictions.userId,
              dietaryRestrictions.personKey,
              dietaryRestrictions.kind,
            ],
            set: columns,
          });
      }
    });
  }

  // Sem `kinds`, remove todas as restrições da pessoa. Devolve quantas saíram.
  async remove(
    userId: number,
    personKey: string,
    kinds?: string[],
  ): Promise<number> {
    const removed = await this.db
      .delete(dietaryRestrictions)
      .where(
        and(
          eq(dietaryRestrictions.userId, userId),
          eq(dietaryRestrictions.personKey, personKey),
          kinds?.length ? inArray(dietaryRestrictions.kind, kinds) : undefined,
        ),
      )
      .returning({ id: dietaryRestrictions.id });
    return removed.length;
  }
}
