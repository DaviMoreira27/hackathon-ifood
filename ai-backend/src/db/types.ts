import type { DbService } from './db.service.js';

export type Database = DbService['db'];
// Transação do drizzle (o argumento do callback de db.transaction).
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
