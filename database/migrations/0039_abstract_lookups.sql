-- Abstracts looked up in open scholarly metadata for journal items whose feed and page give none
-- (content/abstracts.ts). One row per article: tries so far, when to try again, and where an abstract
-- was found. Indexes lag, so a miss is retried on a widening schedule until the tries run out.
CREATE TABLE IF NOT EXISTS abstract_lookups (
  article_id   text PRIMARY KEY REFERENCES articles (id) ON DELETE CASCADE,
  attempts     integer NOT NULL DEFAULT 0,
  next_try_at  timestamptz NOT NULL DEFAULT now(),
  found_at     timestamptz,
  provider     text,
  doi          text,
  last_error   text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS abstract_lookups_due_idx ON abstract_lookups (next_try_at) WHERE found_at IS NULL;
