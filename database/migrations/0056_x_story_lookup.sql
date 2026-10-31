-- X posts found for hot stories (events/x-lookup.ts). External: never fetched on a schedule; each post
-- is heat evidence only, never selected or shown in the pool. It uses the existing everyinfra:twitter
-- share (the three topic searches are stopped); no budget number changes.
INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, tags, track, region, enabled, health)
VALUES ('x-story-lookup', 'X · 事件讨论', 'external', '{}'::jsonb, 'T2', 'hot_signal', 1440, ARRAY['EveryInfra', 'X', '事件反查'], 'mixed', NULL, true, 'unknown')
ON CONFLICT (id) DO NOTHING;
UPDATE budgets SET note = 'EveryInfra X：热点事件按事件反查' WHERE service = 'everyinfra:twitter';
