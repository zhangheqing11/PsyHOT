-- Which side of the daily report a subscriber reads: both tracks (combined, the default and what every
-- existing subscriber is) or only the academic or only the industry track.
ALTER TABLE email_subscribers ADD COLUMN IF NOT EXISTS track text NOT NULL DEFAULT 'combined' CHECK (track IN ('combined', 'academic', 'industry'));
