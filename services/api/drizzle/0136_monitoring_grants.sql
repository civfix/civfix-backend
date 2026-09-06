-- =============================================================================
-- 0136_monitoring_grants.sql
-- -----------------------------------------------------------------------------
-- Read-only SELECT for the Prometheus postgres_exporter role on the tables its
-- queries.yaml gauges scrape (W2.10): broadcast throughput, stuck sends, stuck
-- exports, and the analytics grid.
--
-- The `pg_roles` guard is LOAD-BEARING, not defensive style. The `monitoring`
-- role exists only on the production box (monitoring is prod-only, gated by
-- env/prod.sh). Staging, local dev and the testcontainers integration suite have
-- no such role, and a bare GRANT there aborts the whole migration transaction --
-- which would mean the schema could not be created anywhere except prod.
--
-- Grants are SELECT ONLY and enumerated table by table: the exporter must never
-- be able to read a roster, a message body or a contact detail, so this list must
-- never grow to include a table that holds one. Every table below is either
-- content-free (deliveries, exports) or aggregate-only (event_metrics_daily);
-- `broadcasts` carries a subject and body, so it is granted at the COLUMN level
-- with the content columns withheld.
--
-- pgboss.* grants are deliberately NOT here: pg-boss owns that schema and
-- recreates objects on version upgrades, so those are a documented one-time
-- on-box step in civfix-infra/monitoring/README.md.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monitoring') THEN
    GRANT SELECT (id, cleanup_id, kind, status, scheduled_at, planned_at, started_at,
                  finished_at, chunk_count, recipient_count, sent_count, failed_count,
                  suppressed_count, created_at, updated_at)
      ON broadcasts TO monitoring;
    GRANT SELECT ON broadcast_deliveries TO monitoring;
    GRANT SELECT ON host_exports TO monitoring;
    GRANT SELECT ON event_metrics_daily TO monitoring;
  END IF;
END
$$;
