-- A Xiaohongshu note's participant is its author, not the keyword entrance that found it.
-- New listings store the author's id (raw.participant = xhs-author:<id>); notes collected before
-- that carry only the author's name, which stands in for them.
UPDATE articles a
SET raw = coalesce(a.raw, '{}'::jsonb) || jsonb_build_object('participant', 'xhs-author-name:' || lower(btrim(a.author)))
FROM sources s
WHERE s.id = a.source_id AND s.config->>'adapter' = 'everyinfra_xhs'
  AND btrim(coalesce(a.author, '')) <> '' AND NOT (coalesce(a.raw, '{}'::jsonb) ? 'participant');

-- Their heat evidence follows; a source's signal group still wins.
UPDATE story_signals ss
SET participant_key = a.raw->>'participant'
FROM articles a JOIN sources s ON s.id = a.source_id
WHERE ss.article_id = a.id AND s.signal_group_id IS NULL AND a.raw ? 'participant'
  AND ss.participant_key = 'source:' || a.source_id;
