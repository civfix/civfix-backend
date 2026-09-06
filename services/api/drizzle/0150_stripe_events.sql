-- =============================================================================
-- 0150_stripe_events.sql
-- -----------------------------------------------------------------------------
-- The durable webhook event log. This table is what makes the Stripe webhook
-- route safe to answer 5xx from: the ONLY path that returns a 5xx is a failure
-- to insert here. Everything after the insert is best-effort, because the row is
-- already durable and the */5 sweep re-enqueues anything unprocessed.
--
-- Deduplication is by Stripe's own event id (the PK) with
-- `INSERT ... ON CONFLICT DO NOTHING RETURNING id`: zero rows returned means a
-- duplicate delivery, which answers 200 and stops. That is what makes blue/green
-- duplicate POSTs a no-op.
--
-- THERE IS DELIBERATELY NO UNIQUE ON (type, object_id). Stripe emits many
-- `account.updated` events for the same account and many `charge.refunded`
-- events for the same charge; uniqueness there would silently drop real state
-- changes. Idempotence of the EFFECTS is achieved by re-retrieving the object
-- and applying conditional, monotonic updates -- never by pretending the second
-- event did not happen.
--
-- `payload` is the raw verified event body, kept for reconciliation and dispute
-- defence. It expires at 400 days (longer than Stripe's own 3-day retry window
-- and long enough to cover a chargeback lifecycle). It is NEVER logged: the pino
-- redact list and the GlitchTip scrubber both drop it.
--
-- `scope` records which webhook endpoint the event arrived on, and the route
-- enforces the invariant that a `connect` event carries an account id and a
-- `platform` event does not.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/stripe_events.ts.
--
-- Conventions: CREATE TABLE / INDEX IF NOT EXISTS; one concern per file;
-- non-CONCURRENTLY builds accepted (brand-new, empty table). Forward-only.
-- Ordering rules: standalone (no foreign keys -- an event may reference an
-- account civfix has never seen).
-- =============================================================================

CREATE TABLE IF NOT EXISTS stripe_events (
  id              text PRIMARY KEY,
  scope           text NOT NULL CHECK (scope IN ('connect','platform')),
  type            text NOT NULL,
  account_id      text,
  object_id       text,
  livemode        boolean NOT NULL DEFAULT false,
  api_version     text,
  payload         jsonb NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error           text,
  retention_until timestamptz NOT NULL
);

-- The */5 sweep: unprocessed, oldest first. Also the source of the
-- civfix_stripe_events_unprocessed gauge.
CREATE INDEX IF NOT EXISTS stripe_events_unprocessed_idx
  ON stripe_events (received_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS stripe_events_failed_idx
  ON stripe_events (received_at DESC)
  WHERE processed_at IS NULL AND error IS NOT NULL;

CREATE INDEX IF NOT EXISTS stripe_events_account_idx
  ON stripe_events (account_id, received_at DESC)
  WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS stripe_events_object_idx
  ON stripe_events (object_id, received_at DESC)
  WHERE object_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS stripe_events_retention_idx
  ON stripe_events (retention_until);

COMMENT ON COLUMN stripe_events.payload IS
  'The raw VERIFIED event body. Never logged and never serialized into an error report: it can carry donor email and amounts. Reaped at retention_until (received_at + 400 days).';
