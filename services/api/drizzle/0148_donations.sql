-- =============================================================================
-- 0148_donations.sql
-- -----------------------------------------------------------------------------
-- The donation record. This is a FINANCIAL CORE row: it is never deleted, by any
-- lane, ever. At `retention_until` (charge date + 7 years) the retention sweep
-- NULLs the contact columns; the row, its amounts and its pseudonymous
-- `donor_key` survive, because a deleted donation destroys the receipt re-issue
-- path, the dispute defence and the section 321 remittance statement.
--
-- MONEY IS INTEGER MINOR UNITS ONLY: `bigint` + `char(3) CHECK 'USD'`. There is
-- no numeric, no float and no decimal string anywhere in this schema. Rounding
-- happens once, in the pure fee math in @civfix/shared/payments.
--
-- CARD DATA NEVER REACHES civfix. The only card-shaped columns are `card_brand`
-- and `card_last4`, both returned by Stripe on the charge. There is no PAN, no
-- expiry, no CVC, no payment-method id, and no Customer object.
--
-- STATUS IS MONOTONIC. Webhooks arrive out of order and duplicated, so status
-- only ever advances by DONATION_STATUS_RANK (@civfix/shared/payments
-- `advanceStatus`) inside a conditional UPDATE. Disputes are a SEPARATE column
-- so a dispute cannot rewind a refund and vice versa.
--
-- IDEMPOTENCY IS ON THIS ROW, NOT IN `idempotency_keys`. The generic table keys
-- on a `uuid` with a 48h sweep; a donation key is a client string and financial
-- dedupe is a permanent artifact. `(idempotency_owner, idempotency_key)` is
-- unique, so a replayed checkout returns the SAME donation and the same Stripe
-- session instead of charging twice.
--
-- `eligibility_snapshot` freezes the section 316 gate evidence at authorization
-- time: the verdict, the source revisions it was computed from and the check
-- ids. It is the answer to "why did you let this charity be solicited for on
-- this date".
--
-- LOCK ORDER: see the banner in 0145_org_stripe_accounts.sql. A donation
-- transaction never touches cleanups*: `event_id` is a nullable attribution
-- pointer read outside the transaction, and the donation belongs to the ORG.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/donations.ts.
--
-- Conventions: CREATE TABLE / INDEX IF NOT EXISTS; one concern per file;
-- non-CONCURRENTLY builds accepted (brand-new, empty table). Forward-only.
-- Ordering rules: requires 0105_organizations.sql (organizations), 0001_core.sql
-- (users, cleanups), 0000_extensions.sql (citext, gen_random_uuid).
-- =============================================================================

CREATE TABLE IF NOT EXISTS donations (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference                   text NOT NULL,
  donor_key                   uuid NOT NULL,
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  event_id                    uuid REFERENCES cleanups(id) ON DELETE SET NULL,
  user_id                     uuid REFERENCES users(id) ON DELETE SET NULL,
  profile_unlinked_at         timestamptz,
  donor_email                 citext,
  donor_name                  text,
  share_identity_with_org     boolean NOT NULL DEFAULT false,
  amount_minor                bigint NOT NULL CHECK (amount_minor > 0),
  currency                    char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  fee_bps                     integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 2000),
  fee_platform_minor          bigint NOT NULL DEFAULT 0 CHECK (fee_platform_minor >= 0),
  fee_stripe_minor            bigint CHECK (fee_stripe_minor IS NULL OR fee_stripe_minor >= 0),
  net_minor                   bigint,
  status                      text NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','succeeded','failed','refunded','partially_refunded')),
  failure_reason              text,
  dispute_state               text NOT NULL DEFAULT 'none'
                                CHECK (dispute_state IN ('none','open','won','lost','warning')),
  refunded_total_minor        bigint NOT NULL DEFAULT 0 CHECK (refunded_total_minor >= 0),
  fee_refunded_minor          bigint NOT NULL DEFAULT 0 CHECK (fee_refunded_minor >= 0),
  stripe_account_id           text NOT NULL,
  stripe_checkout_session_id  text,
  stripe_payment_intent_id    text,
  stripe_charge_id            text,
  stripe_application_fee_id   text,
  card_brand                  text,
  card_last4                  text CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  livemode                    boolean NOT NULL DEFAULT false,
  charged_at                  timestamptz,
  session_expires_at          timestamptz,
  receipt_attempt_at          timestamptz,
  receipt_sent_at             timestamptz,
  receipt_key                 text,
  receipt_document_version    text,
  consent_terms_version       text,
  consent_disclosure_version  text,
  consent_record_id           uuid,
  eligibility_snapshot        jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_owner           text NOT NULL,
  idempotency_key             text NOT NULL,
  retention_until             timestamptz,
  last_polled_at              timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT donations_platform_fee_bound_check CHECK (fee_platform_minor <= amount_minor),
  CONSTRAINT donations_refund_bound_check CHECK (refunded_total_minor <= amount_minor),
  CONSTRAINT donations_fee_refund_bound_check CHECK (fee_refunded_minor <= fee_platform_minor)
);

CREATE UNIQUE INDEX IF NOT EXISTS donations_reference_uidx
  ON donations (reference);

CREATE UNIQUE INDEX IF NOT EXISTS donations_idempotency_uidx
  ON donations (idempotency_owner, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS donations_checkout_session_uidx
  ON donations (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS donations_payment_intent_uidx
  ON donations (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS donations_charge_idx
  ON donations (stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS donations_org_charged_idx
  ON donations (organization_id, charged_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS donations_org_created_idx
  ON donations (organization_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS donations_user_charged_idx
  ON donations (user_id, charged_at DESC, id DESC)
  WHERE user_id IS NOT NULL;

-- The expiry arm: pending rows past their session expiry, oldest first.
CREATE INDEX IF NOT EXISTS donations_pending_expiry_idx
  ON donations (session_expires_at)
  WHERE status = 'pending';

-- Receipt due: succeeded, not yet sent. Drives donation.receipt and the
-- civfix_donation_receipts_pending gauge.
CREATE INDEX IF NOT EXISTS donations_receipt_due_idx
  ON donations (charged_at)
  WHERE status IN ('succeeded','partially_refunded') AND receipt_sent_at IS NULL;

CREATE INDEX IF NOT EXISTS donations_retention_idx
  ON donations (retention_until)
  WHERE retention_until IS NOT NULL AND donor_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS donations_event_idx
  ON donations (event_id)
  WHERE event_id IS NOT NULL;

COMMENT ON TABLE donations IS
  'FINANCIAL CORE. Never deleted by any retention or erasure lane. Account deletion NULLs user_id and stamps profile_unlinked_at; the 7-year sweep NULLs donor_email/donor_name only. The pseudonymous donor_key always survives.';

COMMENT ON COLUMN donations.charged_at IS
  'The card charge instant reported by Stripe (charge.created). This is the IRS contribution date printed on the receipt -- never substitute the row created_at or the webhook arrival time.';

COMMENT ON COLUMN donations.eligibility_snapshot IS
  'Section 316 gate evidence frozen at authorization: verdict, reasons, source revision dates and the check ids consulted. Answers "why was this charity solicitable on this date" without replaying the lists.';
