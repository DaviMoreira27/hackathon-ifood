CREATE TYPE order_status AS ENUM ('collecting', 'confirmed', 'paying', 'paid');
CREATE TYPE cart_status  AS ENUM ('pending', 'confirmed', 'paid');
CREATE TYPE message_role AS ENUM ('user', 'assistant', 'tool');

CREATE TABLE users (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,
  ifood_token      TEXT,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_owner   ON orders(owner_user_id);
CREATE INDEX idx_carts_order    ON carts(order_id);
CREATE INDEX idx_messages_chat  ON messages(chat_id, created_at);
