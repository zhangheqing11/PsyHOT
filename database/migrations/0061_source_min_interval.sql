ALTER TABLE sources ADD COLUMN min_interval_minutes integer
  CHECK (min_interval_minutes BETWEEN 1 AND 10080);

COMMENT ON COLUMN sources.min_interval_minutes IS
  '配置或站长设定的最短抓取间隔；自动调频不会比它更频繁';
