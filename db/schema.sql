CREATE TABLE IF NOT EXISTS penny_users (
  id TEXT PRIMARY KEY,
  sender_key TEXT UNIQUE NOT NULL,
  space_key TEXT NOT NULL,
  mandate JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS message_receipts (
  message_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES penny_users(id),
  idempotency_key TEXT UNIQUE NOT NULL,
  body JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS simulations (
  user_id TEXT PRIMARY KEY REFERENCES penny_users(id),
  body JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES penny_users(id),
  type TEXT NOT NULL,
  original_message_id TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_user_created_idx ON audit_events(user_id, created_at);

-- Existing installs apply db/migrations/002_persistent_memory.sql after this base schema.
