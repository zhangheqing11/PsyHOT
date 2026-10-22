-- Fixed WeChat accounts are listed through EveryInfra again (sources/mp.ts), paid per call. Each
-- account is listed as often as it publishes: daily for the busy ones, every two or three days for
-- the rest. Every listed article must carry the account's __biz (verified in WeRSS earlier), so a
-- wrong account id costs one listing and stops the source instead of buying another account's
-- articles. Account ids whose listing was another account (中国药闻, 心理科学, 情感计算, 观心日记) are
-- removed until scripts/resolve-wechat-accounts.ts finds the right ones; names that EveryInfra
-- resolved to the verified account are replaced by that account's ghid.
WITH plan(id, minutes, ghid, clear) AS (VALUES
  ('wechat-camh', 1440, NULL, false), ('wechat-nhc', 1440, NULL, false), ('wechat-nmpa', 1440, NULL, true),
  ('wechat-psych-cas', 1440, NULL, false), ('wechat-cps', 1440, NULL, false), ('wechat-zhonghua-psychiatry', 1440, NULL, false),
  ('wechat-mindseek', 1440, NULL, false), ('wechat-psychology-open-science', 1440, 'gh_cb553e387533', false),
  ('wechat-xlkx', 1440, NULL, true), ('wechat-psybrain-frontier', 1440, 'gh_302c0940c5ff', false),
  ('wechat-medlive-psy', 1440, 'gh_c5042bf4d403', false), ('wechat-yxj-psych', 1440, NULL, false),
  ('wechat-psychiatry-new-views', 2880, NULL, false), ('wechat-ibraintalk', 2880, 'gh_d8921b41959a', false),
  ('wechat-mh686', 2880, NULL, false), ('wechat-cjcp', 2880, NULL, false),
  ('wechat-xlxb', 4320, NULL, false), ('wechat-affective-computing', 4320, NULL, true), ('wechat-cps-registration', 4320, NULL, false),
  ('wechat-psychcomm', 4320, 'gh_74c602011cdd', false), ('wechat-xlkxjz', 4320, NULL, false), ('wechat-ncmhc', 4320, NULL, false),
  ('wechat-cog-neuro-frontier', 4320, NULL, false), ('wechat-psychiatry-navigator', 4320, NULL, false), ('wechat-psynote', 4320, NULL, true),
  ('wechat-libpsy', 4320, NULL, false), ('wechat-openscience', 4320, NULL, false), ('wechat-neurohub', 4320, NULL, false),
  ('wechat-neureality', 4320, NULL, false), ('wechat-psyculture', 4320, NULL, false), ('wechat-drxin', 4320, NULL, false),
  ('wechat-ye', 4320, NULL, false), ('wechat-swarma', 4320, NULL, false), ('wechat-melab', 4320, NULL, false)
), before AS MATERIALIZED (
  SELECT s.id, s.config, s.cursor, s.interval_minutes, s.tags FROM sources s JOIN plan p ON p.id = s.id WHERE s.kind = 'mp_account'
), changed AS (
  UPDATE sources s SET
    config = CASE WHEN p.ghid IS NOT NULL THEN (s.config - 'werssFeedId' - 'wxid') || jsonb_build_object('ghid', p.ghid)
                  WHEN p.clear THEN s.config - 'werssFeedId' - 'wxid' - 'ghid'
                  ELSE s.config - 'werssFeedId' END,
    tags = array_remove(s.tags, 'werss'),
    cursor = coalesce(s.cursor, '{}'::jsonb) - 'werssInitialized' - 'retryAt',
    interval_minutes = p.minutes,
    health = CASE WHEN s.enabled THEN 'unknown' ELSE 'paused' END, fail_count = 0, last_error = NULL,
    next_fetch_at = now(), updated_at = now()
  FROM plan p WHERE s.id = p.id AND s.kind = 'mp_account'
  RETURNING s.id, s.config, s.interval_minutes
)
INSERT INTO audit_log (actor, action, subject, reason, before, after)
SELECT 'migration:0049', 'source.update', 'source:' || c.id,
       'Fixed WeChat accounts listed through EveryInfra again; interval by activity; account verified by __biz',
       to_jsonb(b), jsonb_build_object('config', c.config, 'interval_minutes', c.interval_minutes)
FROM changed c JOIN before b ON b.id = c.id;

-- A WeChat listing is paid too: never more often than twice a day, whoever writes the interval.
UPDATE sources SET interval_minutes = greatest(interval_minutes, 720) WHERE kind = 'mp_account';
ALTER TABLE sources DROP CONSTRAINT sources_paid_interval_floor;
ALTER TABLE sources ADD CONSTRAINT sources_paid_interval_floor CHECK (CASE
  WHEN kind = 'mp_account' THEN interval_minutes >= 720
  WHEN config->>'adapter' = 'everyinfra_xhs' THEN interval_minutes >= 720
  WHEN config->>'adapter' = 'everyinfra_x' THEN interval_minutes >= 360
  ELSE true END);
