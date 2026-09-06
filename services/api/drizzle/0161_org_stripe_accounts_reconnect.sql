-- =============================================================================
-- 0161_org_stripe_accounts_reconnect.sql
-- -----------------------------------------------------------------------------
-- Gives a deauthorized payout account a way back.
--
-- An organization that disconnects civfix from its Stripe dashboard lands in
-- deauthorized_at IS NOT NULL with donations disabled for reason
-- 'deauthorized', and nothing could clear either: the org row already exists so
-- the connect flow returned early, and the sticky-disable guard refuses the
-- organization's own re-enable. reconnect_attempts is the attempt counter that
-- makes each reconnect its own Stripe idempotency key (a reconnect must mint a
-- NEW connected account, not replay the original one), and
-- previous_stripe_account_ids keeps the accounts the org has been relinked away
-- from so a historical donation's stripe_account_id can still be explained.
--
-- Two nullable-with-default column adds on a table with at most a few hundred
-- rows: Postgres 11+ stores the default in the catalog, so no table rewrite.
--
-- CANONICAL DDL: hand-authored source of truth. Mirrors:
-- schema/org_stripe_accounts.ts.
--
-- LOCK ORDER: org_stripe_accounts
-- =============================================================================

ALTER TABLE org_stripe_accounts
  ADD COLUMN IF NOT EXISTS reconnect_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE org_stripe_accounts
  ADD COLUMN IF NOT EXISTS previous_stripe_account_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN org_stripe_accounts.reconnect_attempts IS
  'Number of times this organization has reconnected a payout account after a deauthorization. Feeds the createConnectedAccount idempotency key suffix (acct:<org>:v2:<n>) so each attempt mints a new connected account instead of replaying the deauthorized one.';
