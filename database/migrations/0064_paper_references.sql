-- Citation discovery is separate from event equivalence: a report may cite several different papers.
CREATE TABLE paper_reference_scans (
  report_id text PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  input_revision integer NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE paper_doi_registry (
  doi text PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  publisher_ids text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX paper_doi_registry_article_idx ON paper_doi_registry(article_id);
CREATE INDEX paper_doi_registry_publisher_ids_idx ON paper_doi_registry USING gin(publisher_ids);
CREATE TABLE paper_references (
  id bigserial PRIMARY KEY,
  report_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  reference_key text NOT NULL,
  input_revision integer NOT NULL,
  doi text,
  title text,
  pii text,
  paper_id text REFERENCES articles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'not_found', 'failed', 'paused')),
  attempts integer NOT NULL DEFAULT 0,
  next_try_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, reference_key)
);
CREATE INDEX paper_references_due_idx ON paper_references(next_try_at,id) WHERE status <> 'resolved';
CREATE INDEX paper_references_paper_idx ON paper_references(paper_id) WHERE paper_id IS NOT NULL;
