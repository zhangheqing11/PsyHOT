-- Add immutable context snapshots and optimistic concurrency to the existing 0042 label queue.
-- 0042 owns the queue/decision/split columns; this migration must stay additive so an already
-- migrated database never needs a second selection_labels table.
ALTER TABLE selection_labels
  ADD COLUMN IF NOT EXISTS actor text,
  ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Existing 0042 rows have queued_at/labeled_by, while new code records both names for compatibility.
UPDATE selection_labels
SET actor = COALESCE(actor, labeled_by),
    created_at = COALESCE(queued_at, created_at, now()),
    updated_at = COALESCE(labeled_at, queued_at, updated_at, now())
WHERE actor IS NULL OR created_at IS NULL OR updated_at IS NULL;

CREATE INDEX IF NOT EXISTS selection_labels_queue_idx ON selection_labels (queue, split, updated_at DESC, article_id);
CREATE INDEX IF NOT EXISTS selection_labels_decision_idx ON selection_labels (decision, updated_at DESC, article_id);

DO $$
BEGIN
  ALTER TABLE selection_labels ADD CONSTRAINT selection_labels_version_check CHECK (version > 0);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
