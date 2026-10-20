-- Fixed WeChat subscriptions use cached WeRSS feeds; no paid account polling.
WITH mapping(id, feed_id, biz) AS (VALUES
  ('wechat-camh', 'MP_WXS_3529028237', 'MzUyOTAyODIzNw=='),
  ('wechat-nhc', 'MP_WXS_2396268083', 'MjM5NjI2ODA4Mw=='),
  ('wechat-nmpa', 'MP_WXS_3928204688', 'MzkyODIwNDY4OA=='),
  ('wechat-psych-cas', 'MP_WXS_3078232913', 'MzA3ODIzMjkxMw=='),
  ('wechat-cps', 'MP_WXS_3094558164', 'MzA5NDU1ODE2NA=='),
  ('wechat-cps-registration', 'MP_WXS_3873845201', 'Mzg3Mzg0NTIwMQ=='),
  ('wechat-xlxb', 'MP_WXS_3244786766', 'MzI0NDc4Njc2Ng=='),
  ('wechat-xlkxjz', 'MP_WXS_3204787135', 'MzIwNDc4NzEzNQ=='),
  ('wechat-xlkx', 'MP_WXS_3933391715', 'MzkzMzM5MTcxNQ=='),
  ('wechat-psychcomm', 'MP_WXS_3581564114', 'MzU4MTU2NDExNA=='),
  ('wechat-psychology-open-science', 'MP_WXS_3564778256', 'MzU2NDc3ODI1Ng=='),
  ('wechat-libpsy', 'MP_WXS_3535989134', 'MzUzNTk4OTEzNA=='),
  ('wechat-psybrain-frontier', 'MP_WXS_3621195298', 'MzYyMTE5NTI5OA=='),
  ('wechat-ibraintalk', 'MP_WXS_3286640207', 'MzI4NjY0MDIwNw=='),
  ('wechat-affective-computing', 'MP_WXS_3931328140', 'MzkzMTMyODE0MA=='),
  ('wechat-medlive-psy', 'MP_WXS_2395247680', 'MjM5NTI0NzY4MA=='),
  ('wechat-mindseek', 'MP_WXS_3191532380', 'MzE5MTUzMjM4MA=='),
  ('wechat-psynote', 'MP_WXS_3635882422', 'MzYzNTg4MjQyMg=='),
  ('wechat-openscience', 'MP_WXS_3511048448', 'MzUxMTA0ODQ0OA=='),
  ('wechat-neurohub', 'MP_WXS_3283748947', 'MzI4Mzc0ODk0Nw=='),
  ('wechat-neureality', 'MP_WXS_3917863916', 'MzkxNzg2MzkxNg=='),
  ('wechat-psyculture', 'MP_WXS_3252628173', 'MzI1MjYyODE3Mw=='),
  ('wechat-drxin', 'MP_WXS_3510313283', 'MzUxMDMxMzI4Mw=='),
  ('wechat-ye', 'MP_WXS_3578670356', 'MzU3ODY3MDM1Ng=='),
  ('wechat-swarma', 'MP_WXS_3232427490', 'MzIzMjQyNzQ5MA=='),
  ('wechat-melab', 'MP_WXS_3863764501', 'Mzg2Mzc2NDUwMQ=='),
  ('wechat-cjcp', 'MP_WXS_3944720968', 'Mzk0NDcyMDk2OA=='),
  ('wechat-cog-neuro-frontier', 'MP_WXS_3862885772', 'Mzg2Mjg4NTc3Mg=='),
  ('wechat-mh686', 'MP_WXS_3623281353', 'MzYyMzI4MTM1Mw=='),
  ('wechat-ncmhc', 'MP_WXS_3016398840', 'MzAxNjM5ODg0MA=='),
  ('wechat-psychiatry-navigator', 'MP_WXS_3548678859', 'MzU0ODY3ODg1OQ=='),
  ('wechat-psychiatry-new-views', 'MP_WXS_3572822140', 'MzU3MjgyMjE0MA=='),
  ('wechat-yxj-psych', 'MP_WXS_3226952005', 'MzIyNjk1MjAwNQ=='),
  ('wechat-zhonghua-psychiatry', 'MP_WXS_3007510586', 'MzAwNzUxMDU4Ng==')
), before AS MATERIALIZED (
  SELECT s.id, s.kind, s.config, s.cursor, s.interval_minutes, s.tags
  FROM sources s JOIN mapping m ON m.id = s.id WHERE s.kind IN ('mp_account', 'external')
), changed AS (
  UPDATE sources s SET kind = 'mp_account',
    config = s.config || jsonb_build_object('werssFeedId', m.feed_id, 'wechatBiz', m.biz),
    tags = ARRAY(SELECT DISTINCT x FROM unnest(s.tags || ARRAY['werss']) AS x),
    cursor = coalesce(s.cursor, '{}'::jsonb) - 'retryAt' - 'lastCheckedAt',
    health = CASE WHEN s.enabled THEN 'unknown' ELSE 'paused' END, fail_count = 0, last_error = NULL, last_ok_at = NULL,
    interval_minutes = 30, next_fetch_at = now(), updated_at = now()
  FROM mapping m, before b WHERE s.id = m.id AND s.id = b.id
  RETURNING s.id, to_jsonb(b) AS previous, jsonb_build_object('kind', s.kind, 'config', s.config, 'interval_minutes', s.interval_minutes) AS current
)
INSERT INTO audit_log(actor, action, subject, reason, before, after)
SELECT 'migration:0045', 'source.update', 'source:' || id,
       'Fixed subscriptions read WeRSS cache; paid discovery remains explicit', previous, current FROM changed;
