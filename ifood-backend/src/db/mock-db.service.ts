import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import pg from 'pg';
import { config } from '../config.js';

// O mock usa o mesmo Postgres do projeto, mas só o schema "mock_ifood": ele nunca lê nem escreve
// nas tabelas do ai-backend (simula um serviço externo).
const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS mock_ifood;

CREATE TABLE IF NOT EXISTS mock_ifood.charges (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference    TEXT NOT NULL UNIQUE,
  amount_cents INT  NOT NULL CHECK (amount_cents > 0),
  description  TEXT NOT NULL DEFAULT '',
  token_hash   TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
  expires_at   TIMESTAMPTZ NOT NULL,
  paid_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outbox transacional: o evento é gravado na mesma transação que marca a cobrança como paga e
-- só depois é enviado ao RabbitMQ. Se o broker estiver fora, nada se perde.
CREATE TABLE IF NOT EXISTS mock_ifood.outbox (
  id           BIGSERIAL PRIMARY KEY,
  event_id     UUID  NOT NULL UNIQUE,
  type         TEXT  NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON mock_ifood.outbox (id) WHERE published_at IS NULL;
`;

@Injectable()
export class MockDbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MockDbService.name);
  readonly pool = new pg.Pool({ connectionString: config.databaseUrl });

  constructor() {
    // Sem isso, um erro em conexão ociosa derrubaria o processo.
    this.pool.on('error', (err) =>
      this.logger.error(`Erro em conexão ociosa do Postgres: ${err.message}`),
    );
  }

  private schemaReady?: Promise<void>;

  // Memoizado: o publisher de eventos também espera o schema antes de consultar o outbox.
  ready(): Promise<void> {
    this.schemaReady ??= this.pool.query(SCHEMA_SQL).then(() => {
      this.logger.log('Schema mock_ifood pronto');
    });
    return this.schemaReady;
  }

  async onModuleInit(): Promise<void> {
    await this.ready();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
