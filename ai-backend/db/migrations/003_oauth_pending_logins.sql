-- Logins OAuth em andamento (PKCE) passam a viver no banco: reiniciar o back não invalida o link
-- de login que o usuário acabou de receber. O code_verifier fica cifrado (TOKEN_ENCRYPTION_KEY).
-- Idempotente: pode rodar mais de uma vez.
CREATE TABLE IF NOT EXISTS oauth_pending_logins (
  state             TEXT PRIMARY KEY,
  chat_id           BIGINT NOT NULL,
  code_verifier_enc TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_pending_created ON oauth_pending_logins (created_at);
