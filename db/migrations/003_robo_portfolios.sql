BEGIN;

ALTER TABLE mandates ADD COLUMN IF NOT EXISTS recurring_contribution_cents BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS income_changes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES penny_users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('raise','bonus')),
  label TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK(amount_cents >= 0),
  recurring BOOLEAN NOT NULL,
  effective_date DATE,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS income_changes_user_idx ON income_changes(user_id,created_at);

CREATE TABLE IF NOT EXISTS portfolios (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES penny_users(id) ON DELETE CASCADE,
  proposal_id TEXT NOT NULL,
  risk_preference TEXT NOT NULL CHECK(risk_preference IN ('low','medium','high')),
  seed BIGINT NOT NULL,
  initial_cents BIGINT NOT NULL CHECK(initial_cents >= 0),
  current_cents BIGINT NOT NULL CHECK(current_cents >= 0),
  week INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portfolio_positions (
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  asset_class TEXT NOT NULL,
  target_weight_bps INTEGER NOT NULL CHECK(target_weight_bps BETWEEN 0 AND 10000),
  value_cents BIGINT NOT NULL CHECK(value_cents >= 0),
  PRIMARY KEY(portfolio_id,asset_class)
);

CREATE TABLE IF NOT EXISTS simulated_transactions (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  balance_after_cents BIGINT NOT NULL CHECK(balance_after_cents >= 0),
  week INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS rebalancing_events (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  week INTEGER NOT NULL,
  max_drift_bps INTEGER NOT NULL,
  transaction_ids TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS weekly_snapshots (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  week INTEGER NOT NULL,
  value_cents BIGINT NOT NULL CHECK(value_cents >= 0),
  change_cents BIGINT NOT NULL,
  protected_cash_cents BIGINT NOT NULL CHECK(protected_cash_cents >= 0),
  rebalanced BOOLEAN NOT NULL,
  action_required BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(portfolio_id,week)
);

COMMIT;
