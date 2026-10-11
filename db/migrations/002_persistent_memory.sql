BEGIN;

ALTER TABLE penny_users ADD COLUMN IF NOT EXISTS photon_user_id TEXT;
ALTER TABLE penny_users ADD COLUMN IF NOT EXISTS photon_space_id TEXT;
ALTER TABLE penny_users ADD COLUMN IF NOT EXISTS auth0_subject TEXT;
ALTER TABLE penny_users ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE penny_users ADD COLUMN IF NOT EXISTS consent_version TEXT;
UPDATE penny_users SET photon_user_id=sender_key WHERE photon_user_id IS NULL;
UPDATE penny_users SET photon_space_id=space_key WHERE photon_space_id IS NULL;
UPDATE penny_users SET consent_version=COALESCE(mandate->>'consentVersion','2026-01') WHERE consent_version IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS penny_users_photon_user_id_idx ON penny_users(photon_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS penny_users_auth0_subject_idx ON penny_users(auth0_subject) WHERE auth0_subject IS NOT NULL;

CREATE TABLE IF NOT EXISTS mandates (
  user_id TEXT PRIMARY KEY REFERENCES penny_users(id) ON DELETE CASCADE,
  available_cash_cents BIGINT,
  time_horizon_days INTEGER,
  risk_preference TEXT NOT NULL DEFAULT 'unknown',
  protected_cash_cents BIGINT NOT NULL DEFAULT 0,
  contributions_paused BOOLEAN NOT NULL DEFAULT false,
  approved_proposal_id TEXT,
  pending_proposal_id TEXT,
  consent_version TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES penny_users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK(amount_cents >= 0),
  essential BOOLEAN NOT NULL,
  due_at DATE,
  horizon_days INTEGER,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_user_active_idx ON expenses(user_id,active);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES penny_users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  target_amount_cents BIGINT,
  target_date DATE,
  priority INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_memory (
  user_id TEXT PRIMARY KEY REFERENCES penny_users(id) ON DELETE CASCADE,
  concise_summary TEXT NOT NULL,
  unresolved_questions TEXT[] NOT NULL DEFAULT '{}',
  last_intent TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_events (
  provider_message_id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES penny_users(id) ON DELETE SET NULL,
  direction TEXT NOT NULL,
  intent TEXT,
  processing_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_user_id_fkey;
ALTER TABLE audit_events ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_user_id_fkey
  FOREIGN KEY(user_id) REFERENCES penny_users(id) ON DELETE SET NULL;

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS protected_amount_cents BIGINT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS simulated_investment_amount_cents BIGINT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS plan_type TEXT NOT NULL DEFAULT 'diversified_paper';
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS reason_codes TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

ALTER TABLE simulations ADD COLUMN IF NOT EXISTS id TEXT;
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS starting_amount_cents BIGINT;
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS current_value_cents BIGINT;
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE simulations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

INSERT INTO mandates(user_id,available_cash_cents,time_horizon_days,risk_preference,
  protected_cash_cents,contributions_paused,approved_proposal_id,pending_proposal_id,
  consent_version,version)
SELECT id,(mandate->>'availableCashCents')::bigint,(mandate->>'timeHorizonDays')::integer,
  COALESCE(mandate->>'riskPreference','unknown'),COALESCE((mandate->>'protectedCashCents')::bigint,0),
  COALESCE((mandate->>'contributionsPaused')::boolean,false),mandate->>'approvedProposalId',
  mandate->>'pendingProposalId',COALESCE(mandate->>'consentVersion','2026-01'),
  COALESCE((mandate->>'version')::integer,1)
FROM penny_users ON CONFLICT(user_id) DO NOTHING;

INSERT INTO expenses(id,user_id,label,amount_cents,essential,due_at,horizon_days,active)
SELECT e->>'id',u.id,e->>'label',(e->>'amountCents')::bigint,
  COALESCE((e->>'essential')::boolean,true),NULLIF(e->>'dueAt','')::date,
  NULLIF(e->>'horizonDays','')::integer,COALESCE((e->>'active')::boolean,true)
FROM penny_users u CROSS JOIN LATERAL jsonb_array_elements(COALESCE(u.mandate->'expenses','[]'::jsonb)) e
WHERE e ? 'id' ON CONFLICT(id) DO NOTHING;

COMMIT;
