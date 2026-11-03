-- Practitioner roles and impact type on the public projection, so the site and its exits can filter industry
-- items by role (industry/features.ts industryRoles, off by default). Both are copied from the latest analysis
-- (output.roles / output.impact, written by the structure step) when an article is published; they are not
-- tags and never enter search text. Additive: nothing reads these columns while the switch is off.
ALTER TABLE publications ADD COLUMN roles text[] NOT NULL DEFAULT '{}';
ALTER TABLE publications ADD COLUMN impact text;

CREATE INDEX publications_roles_idx ON publications USING gin (roles);

-- Backfill what the analyses already say. Only industry-category items that are not promotions carry roles
-- (the same rule publish.ts applies); roles keep their order, drop unknown keys and repeats, at most three;
-- an impact needs at least one role. Everything else keeps the defaults.
UPDATE publications p
SET roles = picked.roles,
    impact = CASE WHEN a.output->>'impact' IN ('rule', 'resource', 'practice', 'risk', 'landscape') THEN a.output->>'impact' END
FROM analyses a,
  LATERAL (
    SELECT coalesce(array_agg(x.role ORDER BY x.first_at), '{}') AS roles
    FROM (
      SELECT e.role, min(e.at) AS first_at
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.output->'roles') = 'array' THEN a.output->'roles' ELSE '[]'::jsonb END) WITH ORDINALITY AS e(role, at)
      WHERE e.role IN ('counselor', 'psychiatry', 'school', 'community', 'operator')
      GROUP BY e.role ORDER BY min(e.at) LIMIT 3
    ) x
  ) picked
WHERE a.id = p.analysis_id
  AND p.category IN ('policy', 'profession', 'industry', 'digital')
  AND NOT p.promotion
  AND a.output ? 'roles'
  AND cardinality(picked.roles) > 0;
