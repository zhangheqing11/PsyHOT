-- The site owner's own labels for calibrating the selection (docs/selection.md): one row per labelled
-- or queued item. Rows are queued by sampling (scripts/sample-labels.ts) or the weekly review batch,
-- or created when an item is labelled from its detail page; `decision` stays NULL until it is labelled.
CREATE TABLE IF NOT EXISTS selection_labels (
  article_id   text PRIMARY KEY REFERENCES articles (id) ON DELETE CASCADE,
  -- Why it is in the queue: sample (the first sample), promotion / blocked / near_threshold (weekly review), manual.
  queue        text NOT NULL CHECK (queue IN ('sample', 'promotion', 'blocked', 'near_threshold', 'manual')),
  queued_at    timestamptz NOT NULL DEFAULT now(),
  -- development: for tuning; holdout: kept aside to check the tuned rules once.
  split        text NOT NULL DEFAULT 'development' CHECK (split IN ('development', 'holdout')),
  decision     text CHECK (decision IN ('select', 'reject', 'either')),
  note         text,
  labeled_by   text,
  labeled_at   timestamptz
);

CREATE INDEX IF NOT EXISTS selection_labels_pending_idx ON selection_labels (queued_at) WHERE decision IS NULL;
