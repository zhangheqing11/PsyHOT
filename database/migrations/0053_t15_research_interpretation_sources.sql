-- Research-interpretation publications that are held to the intermediate selection threshold.
-- Keep this scoped to the four reviewed editorial MP sources; the guard makes the migration
-- idempotent and avoids changing an operator's later tier decision.
UPDATE sources
SET tier = 'T1_5'
WHERE id IN (
  'wechat-mindseek',
  'wechat-psybrain-frontier',
  'wechat-psychiatry-new-views',
  'wechat-psynote'
)
  AND kind = 'mp_account'
  AND participation_mode = 'editorial'
  AND tier = 'T2';
