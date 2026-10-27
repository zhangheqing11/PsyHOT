-- DeepSeek Search and Fetch (providers/deepseek-tools.ts), $0.75 per 1000 successful requests each.
-- One service cap and a share per use: hot-story web coverage, the body fallback, operator discovery.
INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('deepseek-tools', 30, 150, 350, 'DeepSeek 搜索与抓取（总上限）'),
  ('deepseek-tools:search', 20, 80, 150, 'DeepSeek 搜索：热点事件反查网页报道'),
  ('deepseek-tools:fetch', 10, 40, 100, 'DeepSeek 抓取：正文提取的兜底（不用于有机器人验证的站点）'),
  ('deepseek-tools:discovery', 20, 100, 100, 'DeepSeek 搜索：信源候选发现（运营手动运行）')
ON CONFLICT (service) DO NOTHING;

-- Web pages found for hot stories (events/web-lookup.ts). External: never fetched on a schedule; each
-- page is heat evidence only, never selected or shown in the pool.
INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, tags, track, region, enabled, health)
VALUES ('web-story-lookup', '网页 · 事件报道', 'external', '{}'::jsonb, 'T2', 'hot_signal', 1440, ARRAY['DeepSeek', '事件反查'], 'mixed', NULL, true, 'unknown')
ON CONFLICT (id) DO NOTHING;
