-- A web-lookup run searches up to 60 times (30 stories, two titles each) in about a minute; the first
-- per-minute share (20) deferred every run part way. Raised only where the 0054 defaults still stand.
UPDATE budgets SET per_minute = 90 WHERE service = 'deepseek-tools' AND per_minute = 30;
UPDATE budgets SET per_minute = 70 WHERE service = 'deepseek-tools:search' AND per_minute = 20;
