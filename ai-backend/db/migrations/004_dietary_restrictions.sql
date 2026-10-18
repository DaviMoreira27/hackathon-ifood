-- Restrições alimentares (alergia, intolerância, religião, dieta) que o usuário declarou no chat.
-- Ficam por usuário, não por conversa: valem nos próximos pedidos até ele pedir para remover.
-- person_key = '' é o próprio usuário; senão, o nome normalizado de quem vai comer.
-- Idempotente: pode rodar mais de uma vez.
CREATE TABLE IF NOT EXISTS dietary_restrictions (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_key   TEXT NOT NULL DEFAULT '',
  person_name  TEXT,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('alergia', 'intolerancia', 'religiao', 'dieta')),
  custom_terms JSONB NOT NULL DEFAULT '[]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, person_key, kind)
);
