-- New provider: seed the same runaway-call limits as other model providers; preserve admin changes.
INSERT INTO budgets (service, per_minute, per_hour, per_day, note)
VALUES ('typesafe', 100, 2000, 20000, '业界角色评分熔断（TypeSafe Jev）')
ON CONFLICT (service) DO NOTHING;
