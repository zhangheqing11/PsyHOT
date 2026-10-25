-- Chinese readings of source abstracts. Unlike translations, this table is keyed by the
-- article revision because an abstract can change when an open metadata lookup is refreshed.
-- The source hash makes a stale worker result harmless and gives retries a stable identity.
CREATE TABLE IF NOT EXISTS abstract_translations (
  article_id    text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  revision      integer NOT NULL,
  lang          text NOT NULL DEFAULT 'zh',
  source_hash   text NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending', 'translated', 'failed', 'skipped')),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  text_zh       text,
  receipt_id    bigint REFERENCES receipts (id) ON DELETE SET NULL,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, revision, lang)
);

CREATE INDEX IF NOT EXISTS abstract_translations_due_idx
  ON abstract_translations (status, updated_at)
  WHERE status IN ('pending', 'failed');
