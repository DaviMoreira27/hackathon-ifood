-- Pedido em grupo: participantes, pagadores por carrinho, itens e cobranças.
-- Para bancos criados antes desta mudança. Idempotente: pode rodar mais de uma vez.
--   podman/docker exec -i ifood-postgres psql -U ifood -d ifood < db/migrations/002_group_order_and_payments.sql
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'cancelled';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'completed';

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'void');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE carts ADD COLUMN IF NOT EXISTS restaurant_name TEXT;

CREATE TABLE IF NOT EXISTS participants (
  id         BIGSERIAL PRIMARY KEY,
  order_id   BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, name_key)
);

CREATE TABLE IF NOT EXISTS cart_payers (
  cart_id        BIGINT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  participant_id BIGINT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  PRIMARY KEY (cart_id, participant_id),
  UNIQUE (participant_id)
);

CREATE TABLE IF NOT EXISTS cart_items (
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

CREATE TABLE IF NOT EXISTS payments (
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

CREATE TABLE IF NOT EXISTS processed_events (
  event_id     TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_carts_order_ifood ON carts(order_id, ifood_cart_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_participant_active ON payments(participant_id) WHERE status <> 'void';
CREATE INDEX IF NOT EXISTS idx_payments_cart ON payments(cart_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_cart ON cart_items(cart_id);
