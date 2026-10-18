CREATE TYPE order_status AS ENUM ('collecting', 'confirmed', 'paying', 'paid', 'cancelled', 'completed');
CREATE TYPE cart_status  AS ENUM ('pending', 'confirmed', 'paid');
CREATE TYPE message_role AS ENUM ('user', 'assistant', 'tool');
CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'void');

CREATE TABLE users (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT UNIQUE,
  telegram_chat_id BIGINT UNIQUE,
  ifood_token      TEXT,
  ifood_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ
);

CREATE TABLE orders (
  id            BIGSERIAL PRIMARY KEY,
  owner_user_id BIGINT NOT NULL REFERENCES users(id),
  status        order_status NOT NULL DEFAULT 'collecting',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE carts (
  id            BIGSERIAL PRIMARY KEY,
  order_id      BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  ifood_cart_id TEXT NOT NULL,
  restaurant_name TEXT,
  subtotal      NUMERIC(10, 2) NOT NULL,
  total         NUMERIC(10, 2) NOT NULL,
  status        cart_status NOT NULL DEFAULT 'pending'
);

CREATE TABLE messages (
  id         BIGSERIAL PRIMARY KEY,
  chat_id    BIGINT NOT NULL,
  user_id    BIGINT REFERENCES users(id),
  role       message_role NOT NULL,
  content    TEXT NOT NULL,
  payload    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Quem participa do pedido (só um nome: a pessoa não precisa ter conta nem estar no chat).
CREATE TABLE participants (
  id         BIGSERIAL PRIMARY KEY,
  order_id   BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, name_key)
);

-- Quem paga cada carrinho. UNIQUE (participant_id) é a regra "uma pessoa paga em um carrinho só".
CREATE TABLE cart_payers (
  cart_id        BIGINT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  participant_id BIGINT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  PRIMARY KEY (cart_id, participant_id),
  UNIQUE (participant_id)
);

-- O pagador de um item precisa ser pagador do carrinho do item (FK composta; nula = sem pagador ainda).
CREATE TABLE cart_items (
  id                   BIGSERIAL PRIMARY KEY,
  cart_id              BIGINT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  ifood_item_id        TEXT NOT NULL,
  name                 TEXT NOT NULL,
  unit_price           NUMERIC(10, 2) NOT NULL CHECK (unit_price >= 0),
  quantity             INT NOT NULL CHECK (quantity > 0),
  payer_participant_id BIGINT,
  UNIQUE (cart_id, ifood_item_id),
  FOREIGN KEY (cart_id, payer_participant_id)
    REFERENCES cart_payers (cart_id, participant_id) ON DELETE SET NULL (payer_participant_id)
);

-- Uma cobrança por pagador. external_payment_id / pay_url vêm do provedor de pagamento (mock do iFood).
CREATE TABLE payments (
  id                  BIGSERIAL PRIMARY KEY,
  cart_id             BIGINT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  participant_id      BIGINT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  amount              NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  status              payment_status NOT NULL DEFAULT 'pending',
  external_payment_id TEXT,
  pay_url             TEXT,
  expires_at          TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Eventos já aplicados (consumidor idempotente: o broker entrega "pelo menos uma vez").
CREATE TABLE processed_events (
  event_id     TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Logins OAuth em andamento (PKCE); o code_verifier fica cifrado.
CREATE TABLE oauth_pending_logins (
  state             TEXT PRIMARY KEY,
  chat_id           BIGINT NOT NULL,
  code_verifier_enc TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_oauth_pending_created ON oauth_pending_logins (created_at);

-- Restrições alimentares declaradas no chat; valem nos próximos pedidos. person_key '' = o usuário.
CREATE TABLE dietary_restrictions (
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

-- Trace de cada turno do agente (ferramentas, tokens, latência, validadores, onde parou).
CREATE TABLE agent_turns (
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
CREATE INDEX idx_agent_turns_chat ON agent_turns (chat_id, started_at);

CREATE UNIQUE INDEX uq_carts_order_ifood ON carts(order_id, ifood_cart_id);
-- Cobranças anuladas (void) não contam: a pessoa pode ganhar uma nova ao reabrir o pedido.
CREATE UNIQUE INDEX uq_payments_participant_active ON payments(participant_id) WHERE status <> 'void';
CREATE INDEX idx_payments_cart  ON payments(cart_id);
CREATE INDEX idx_cart_items_cart ON cart_items(cart_id);
CREATE INDEX idx_orders_owner   ON orders(owner_user_id);
CREATE INDEX idx_carts_order    ON carts(order_id);
CREATE INDEX idx_messages_chat  ON messages(chat_id, id);
