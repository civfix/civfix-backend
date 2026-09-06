-- =============================================================================
-- 0153_payments_monitoring_grant.sql
-- -----------------------------------------------------------------------------
-- Least-privilege SELECT for the postgres-exporter `monitoring` role on the
-- payments gauge sources only.
--
-- ROLE-GUARDED: the `monitoring` role is created out of band on the production
-- host (see civfix-infra/monitoring/README.md) and does NOT exist on a
-- developer machine, in CI or in the testcontainers integration suite. A bare
-- GRANT would abort the whole migration file there, so the grant runs only when
-- pg_roles says the role is present. Re-applying is a no-op.
--
-- WHAT IS GRANTED IS THE MINIMUM the payments gauges need, and it is granted at
-- COLUMN level wherever the table holds donor contact or a raw provider payload
-- (same discipline as 0136_monitoring_grants.sql). The exporter must never
-- become a convenient read path for a donor's email, an EIN, a mailing address
-- or a verified webhook body.
--
--   stripe_events                 unprocessed / failed-recent gauges
--                                 (payload WITHHELD -- it carries donor email)
--   donations                     receipts pending, pending stale, amounts
--                                 (donor_email, donor_name, receipt_key,
--                                  eligibility_snapshot, idempotency_* WITHHELD)
--   donation_reconciliation_runs  divergence gauge (CRITICAL at > 0)
--   org_stripe_accounts           blocked / at_risk / pmd-unregistered gauges
--   org_eligibility               ineligible / grace gauges
--                                 (ein, irs_legal_name, irs_address WITHHELD)
--
-- NOT granted at all: donation_refunds, donation_disputes, consent_records,
-- org_eligibility_checks, org_donation_agreement_changes, legal_documents. No
-- gauge needs them.
--
-- Conventions: idempotent DO block; forward-only. Ordering rules: requires every
-- payments table (0145-0152).
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monitoring') THEN
    GRANT SELECT (id, scope, type, account_id, object_id, livemode, api_version,
                  received_at, processed_at, attempts, retention_until)
      ON stripe_events TO monitoring;
    GRANT SELECT (id, organization_id, amount_minor, currency, fee_platform_minor,
                  fee_stripe_minor, net_minor, status, dispute_state,
                  refunded_total_minor, fee_refunded_minor, livemode, charged_at,
                  session_expires_at, receipt_attempt_at, receipt_sent_at,
                  retention_until, created_at, updated_at)
      ON donations TO monitoring;
    GRANT SELECT ON donation_reconciliation_runs TO monitoring;
    GRANT SELECT (organization_id, livemode, details_submitted, charges_enabled,
                  payouts_enabled, disabled_reason, onboarding_state,
                  payment_method_domains, deauthorized_at, reconciled_through,
                  last_synced_at, created_at, updated_at)
      ON org_stripe_accounts TO monitoring;
    GRANT SELECT (organization_id, verdict, group_exemption_subordinate,
                  grace_expires_at, evaluated_at, next_check_at, updated_at)
      ON org_eligibility TO monitoring;
  END IF;
END
$$;
