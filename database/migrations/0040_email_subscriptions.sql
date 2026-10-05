-- Daily report by email. A reader leaves an address, confirms it from the email sent to it, and gets
-- each daily report until they unsubscribe; unsubscribing deletes the address. One token per address
-- serves the confirmation and the unsubscribe links.
CREATE TABLE email_subscribers (
  id              bigserial PRIMARY KEY,
  email           text NOT NULL,
  token           text NOT NULL UNIQUE,
  status          text NOT NULL CHECK (status IN ('pending', 'active')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirm_sent_at timestamptz,
  confirmed_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX email_subscribers_email_idx ON email_subscribers (lower(email));

-- One row per subscriber and issue, so an issue is never sent twice. "sending" left behind by a crash
-- is an outcome we cannot know and is not retried; "failed" is retried a few times.
CREATE TABLE email_deliveries (
  subscriber_id bigint NOT NULL REFERENCES email_subscribers (id) ON DELETE CASCADE,
  report_key    text NOT NULL,
  status        text NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  attempts      integer NOT NULL DEFAULT 1,
  error         text,
  sent_at       timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subscriber_id, report_key)
);

CREATE INDEX email_deliveries_report_idx ON email_deliveries (report_key, status);
