-- These two tables record dry-run runs and candidates only. Actual merges are performed by the
-- legacy repair path in scripts/repair-material-identities.ts.

CREATE TABLE material_identity_repair_runs (
  id             bigserial PRIMARY KEY,
  mode           text NOT NULL CHECK (mode IN ('dry-run', 'apply')),
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'dry-run', 'applied', 'failed', 'cancelled')),
  actor          text NOT NULL,
  reason         text NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  checkpoint     jsonb NOT NULL DEFAULT '{}',
  report         jsonb,
  error          text
);

CREATE INDEX material_identity_repair_runs_status_idx
  ON material_identity_repair_runs (status, started_at DESC);

CREATE TABLE material_identity_repair_checkpoints (
  run_id          bigint NOT NULL REFERENCES material_identity_repair_runs (id) ON DELETE CASCADE,
  candidate_key   text NOT NULL,
  identity_kind   text NOT NULL CHECK (identity_kind IN ('url', 'doi', 'x')),
  article_ids     text[] NOT NULL,
  survivor_id     text,
  duplicate_ids   text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'skipped', 'failed')),
  detail          jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, candidate_key)
);

CREATE INDEX material_identity_repair_checkpoints_status_idx
  ON material_identity_repair_checkpoints (run_id, status, candidate_key);
