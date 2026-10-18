import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
import { appConfig } from '../config/app-config.js';

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly pool = new pg.Pool({
    connectionString: appConfig().databaseUrl,
  });
  readonly db: NodePgDatabase<typeof schema> = drizzle(this.pool, { schema });

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
