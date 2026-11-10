-- Count every confirmation send attempt, including retries and failed sends. Removing an address
-- must not restore the site's daily allowance.
CREATE TABLE subscription_confirm_sends (
  id            bigserial PRIMARY KEY,
  subscriber_id bigint REFERENCES email_subscribers (id) ON DELETE SET NULL,
  sent_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subscription_confirm_sends_sent_at_idx ON subscription_confirm_sends (sent_at);
