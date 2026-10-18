import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

// Mesmo Postgres que o ./dev.sh sobe (porta 5433). Sem este padrão, a ausência de DATABASE_URL
// faria o driver tentar localhost:5432 com o usuário do sistema.
export const DEFAULT_DATABASE_URL =
  'postgresql://ifood:ifood@localhost:5433/ifood';

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
  });
  readonly db: NodePgDatabase<typeof schema> = drizzle(this.pool, { schema });

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
