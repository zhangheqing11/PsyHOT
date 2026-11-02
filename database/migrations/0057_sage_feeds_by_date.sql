-- SAGE's journal feeds (journals.sagepub.com/action/showFeed … type=etoc) list the current issue and
-- the OnlineFirst articles in section order, not by date, and a run stores at most 60 items from the
-- top of a listing (sources/collect.ts). Clinical Psychological Science's feed holds 73 items whose
-- newest (an open-science commentary set, 2026-09-29 to 10-01) sit at positions 68–72 and were never
-- collected. Sorting by the feed's own dates keeps the newest 60. Changing the config also resets the
-- feed's conditional-request validator, so the next run reads the whole feed once.
UPDATE sources SET config = config || '{"sortByPublishedAt": true}'::jsonb
WHERE kind = 'rss' AND config->>'feedUrl' LIKE 'https://journals.sagepub.com/%' AND NOT config ? 'sortByPublishedAt';
