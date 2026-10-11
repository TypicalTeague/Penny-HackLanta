BEGIN;

CREATE TABLE IF NOT EXISTS brokerage_accounts (
  user_id TEXT PRIMARY KEY REFERENCES penny_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('alpaca','fake')),
  account_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  body JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brokerage_transfers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES penny_users(id) ON DELETE CASCADE,
  proposal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brokerage_transfers_user_idx
  ON brokerage_transfers(user_id,created_at);

CREATE TABLE IF NOT EXISTS brokerage_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES penny_users(id) ON DELETE CASCADE,
  proposal_id TEXT NOT NULL,
  client_order_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brokerage_orders_proposal_idx
  ON brokerage_orders(proposal_id,created_at);

CREATE TABLE IF NOT EXISTS brokerage_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES penny_users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  body JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL
);

COMMIT;
