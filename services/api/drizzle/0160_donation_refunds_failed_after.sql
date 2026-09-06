-- =============================================================================
-- 0160_donation_refunds_failed_after.sql
-- -----------------------------------------------------------------------------
-- Adds 'failed_after' to donation_refunds.app_fee_refund_state.
--
-- The organization's refund can be created 'pending' and later move to 'failed'
-- (a card that closed between the charge and the refund). civfix returns its
-- proportional application fee as soon as the refund is recorded, so a refund
-- that fails afterwards leaves a fee civfix already gave back. Stripe has no
-- un-refund for an application fee, so the row is marked 'failed_after' and
-- alerted on rather than silently reversed: the money is recovered by hand.
--
-- 'failed_after' is deliberately OUTSIDE donation_refunds_app_fee_pending_idx's
-- ('pending','failed') predicate — it is terminal and must never be retried.
--
-- Rewrites one CHECK constraint on a table that is empty on every environment
-- at this point in the change set; the drop/add pair takes an ACCESS EXCLUSIVE
-- lock for the duration of one validation scan of zero rows.
--
-- LOCK ORDER: donation_refunds
-- =============================================================================

ALTER TABLE donation_refunds
  DROP CONSTRAINT IF EXISTS donation_refunds_app_fee_refund_state_check;

ALTER TABLE donation_refunds
  ADD CONSTRAINT donation_refunds_app_fee_refund_state_check CHECK (
    app_fee_refund_state IN ('pending','done','skipped','failed','failed_after'));
