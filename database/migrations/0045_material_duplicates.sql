-- Keep duplicate material and its paid analysis for audit; public projections hide aliases.
ALTER TABLE articles ADD COLUMN duplicate_of text REFERENCES articles (id) ON DELETE CASCADE;
ALTER TABLE articles ADD CONSTRAINT articles_duplicate_not_self CHECK (duplicate_of IS DISTINCT FROM id);
CREATE INDEX articles_duplicate_of_idx ON articles (duplicate_of) WHERE duplicate_of IS NOT NULL;

-- A durable checkpoint: a restart between consolidation and rebuilding must resume the rebuild.
CREATE TABLE material_identity_repairs (
  id bigserial PRIMARY KEY,
  story_ids bigint[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rebuilt_at timestamptz
);
