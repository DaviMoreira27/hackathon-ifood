-- Para bancos criados antes desta mudança (init.sql só roda na primeira criação do volume).
-- Idempotente: pode rodar mais de uma vez.
--   podman/docker exec -i ifood-postgres psql -U ifood -d ifood < db/migrations/001_telegram_users_and_message_payload.sql
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ifood_refresh_token TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS payload JSONB;
