-- Trace de cada turno do agente (uma mensagem do usuário até a resposta): ferramentas chamadas,
-- tokens, latência, disparos dos validadores e onde parou. Serve para transformar uma falha de demo
-- num caso reproduzível. Idempotente: pode rodar mais de uma vez.
CREATE TABLE IF NOT EXISTS agent_turns (
  id                 BIGSERIAL PRIMARY KEY,
  chat_id            BIGINT NOT NULL,
  user_id            BIGINT REFERENCES users(id) ON DELETE SET NULL,
  started_at         TIMESTAMPTZ NOT NULL,
  duration_ms        INTEGER NOT NULL,
  rounds             INTEGER NOT NULL,
  outcome            TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  tools              JSONB NOT NULL DEFAULT '[]',
  validator_hits     JSONB NOT NULL DEFAULT '[]',
  error              TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_turns_chat ON agent_turns (chat_id, started_at);
