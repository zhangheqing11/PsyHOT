-- EveryInfra bills every call, whichever platform it reads. Each platform gets its own share of the
-- service's daily budget (everyinfra itself stays the overall cap), so Xiaohongshu cannot use up WeChat's.
ALTER TABLE receipt_attempts ADD COLUMN pool text;
CREATE INDEX receipt_attempts_pool_time_idx ON receipt_attempts (pool, started_at) WHERE pool IS NOT NULL;

INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('everyinfra:xiaohongshu', 10, 40, 25, 'EveryInfra 小红书：关键词与博主列表、博主新笔记正文'),
  ('everyinfra:wechat_oa', 10, 60, 50, 'EveryInfra 公众号：文章列表、新文章正文'),
  ('everyinfra:twitter', 5, 10, 15, 'EveryInfra X 主题检索'),
  ('everyinfra:discovery', 10, 60, 60, 'EveryInfra 公众号候选发现与账号查找（运营手动运行）')
ON CONFLICT (service) DO NOTHING;

-- Intervals up to a week (quiet paid accounts are listed every few days). Paid listings have a floor
-- no writer can go below; the nightly adaptation never touches them (sources/collect.ts) and the
-- admin refuses shorter ones (sources/config-keys.ts paidIntervalFloor).
ALTER TABLE sources DROP CONSTRAINT sources_interval_minutes_check;
ALTER TABLE sources ADD CONSTRAINT sources_interval_minutes_check CHECK (interval_minutes BETWEEN 1 AND 10080);
UPDATE sources SET interval_minutes = greatest(interval_minutes, 720) WHERE config->>'adapter' = 'everyinfra_xhs';
UPDATE sources SET interval_minutes = greatest(interval_minutes, 360) WHERE config->>'adapter' = 'everyinfra_x';
ALTER TABLE sources ADD CONSTRAINT sources_paid_interval_floor CHECK (CASE config->>'adapter'
  WHEN 'everyinfra_xhs' THEN interval_minutes >= 720
  WHEN 'everyinfra_x' THEN interval_minutes >= 360
  ELSE true END);
