-- Each source's track and region (docs/plans/handoff-academic-industry-tracks.md). The track limits the
-- categories its items may take: academic and industry sources stay on their side, mixed sources (the
-- default, which is how every source behaved before) may take any category. The region is where the
-- source's items come from; NULL until it is set.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS track text NOT NULL DEFAULT 'mixed' CHECK (track IN ('academic', 'industry', 'mixed'));
ALTER TABLE sources ADD COLUMN IF NOT EXISTS region text CHECK (region IN ('domestic', 'international'));

-- Promotion: the industry's own advertising (apps, courses, exams, conferences, jobs), told apart by the
-- structure step. Such items are listed in the full feed only: never selected, grouped or exported.
ALTER TABLE publications ADD COLUMN IF NOT EXISTS promotion boolean NOT NULL DEFAULT false;
