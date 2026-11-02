-- Collection rules for sources that were losing articles or dates. The seed only inserts new sources, so a
-- rule changed in industry/sources.json never reaches an existing one; each statement here touches only a
-- source that does not carry the rule yet (an admin's own value stays). Changing the config also resets a
-- feed's conditional-request validator, so the next run reads the whole feed once.

-- 1. Feeds longer than the 60 a run stores (sources/collect.ts) and not in time order: Taylor & Francis
-- journal feeds list their articles in no order (Psychology, Crime & Law: 173 entries, the newest 169th, no
-- new article collected since 2026-10-02). The others are in order today and only guard against it changing.
UPDATE sources SET config = config || '{"sortByPublishedAt": true}'::jsonb, updated_at = now()
WHERE kind = 'rss' AND NOT config ? 'sortByPublishedAt'
  AND (config->>'feedUrl' LIKE 'https://www.tandfonline.com/feed/%'
       OR id IN ('rss-jcpp', 'rss-bjep', 'rss-journal-organizational-behavior', 'rss-biological-psychiatry', 'rss-openai-news'));

-- 2. 心理学报: the list prints the issue, not the day; the article's meta citation_online_date is the day it went online.
UPDATE sources SET config = config || jsonb_build_object('detail', jsonb_build_object(
    'maxFetches', 20,
    'publishedAtRegex', $re$citation_online_date"\s+content="(\d{4}-\d{2}-\d{2})"$re$)),
  updated_at = now()
WHERE id = 'web-xinlixuebao' AND NOT config ? 'detail';

-- 3. 健康报: the list prints no date. The day is in each article's address (/industryNews/2026/1029/515042.html),
-- which the detail page's time replaces where it is read (a run reads at most 12 pages; some pages 404).
-- The person section now links /character/..., which the old deny rule (/news/character/) did not match.
UPDATE sources SET config = config || jsonb_build_object('publishedAtRegex', $re$/(\d{4})/(\d{2})(\d{2})/\d+\.html$re$), updated_at = now()
WHERE id = 'web-jkb-news' AND NOT config ? 'publishedAtRegex';

UPDATE sources SET config = jsonb_set(config, '{detail,upgradeDatePrecision}', 'true'::jsonb), updated_at = now()
WHERE id = 'web-jkb-news' AND jsonb_typeof(config->'detail') = 'object' AND NOT config->'detail' ? 'upgradeDatePrecision';

UPDATE sources SET config = jsonb_set(config, '{denyUrlPrefixes}', coalesce(config->'denyUrlPrefixes', '[]'::jsonb) || '["http://www.jkb.com.cn/character/"]'::jsonb), updated_at = now()
WHERE id = 'web-jkb-news' AND NOT coalesce(config->'denyUrlPrefixes', '[]'::jsonb) ? 'http://www.jkb.com.cn/character/';
