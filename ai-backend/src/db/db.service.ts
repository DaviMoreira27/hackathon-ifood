import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  readonly db: NodePgDatabase<typeof schema> = drizzle(this.pool, { schema });

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
