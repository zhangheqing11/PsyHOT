-- Role-specific selection and the additive industry hot channel. Existing rows keep empty defaults;
-- historical analyses are rerun separately after the feature is enabled.
ALTER TABLE publications ADD COLUMN selected_roles text[] NOT NULL DEFAULT '{}';
ALTER TABLE publications ADD COLUMN hot_pick boolean NOT NULL DEFAULT false;

CREATE TABLE industry_hot_picks (
  article_id text PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  story_id bigint NOT NULL,
  participants int NOT NULL,
  picked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX industry_hot_picks_story_idx ON industry_hot_picks (story_id);
