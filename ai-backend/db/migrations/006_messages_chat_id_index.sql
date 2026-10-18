-- recent() ordena as mensagens do chat por id (linhas da mesma transação dividem o created_at):
-- o índice passa a cobrir (chat_id, id). Idempotente: pode rodar mais de uma vez.
DROP INDEX IF EXISTS idx_messages_chat;
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, id);
