-- EveryInfra serves the paid public-content collectors for WeChat and Xiaohongshu.
-- Keep a conservative default until the operator has observed real usage and adjusts it in Settings.
INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('everyinfra', 10, 100, 1000, 'EveryInfra 微信公众号与小红书（按请求计费）')
ON CONFLICT (service) DO NOTHING;
