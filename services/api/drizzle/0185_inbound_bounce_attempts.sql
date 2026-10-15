-- =============================================================================
-- 0185_inbound_bounce_attempts.sql
-- -----------------------------------------------------------------------------
-- WHY. A DSN stays under inbound/pending/ until its bounce bookkeeping succeeds,
-- so the next sweep can finish what a failed run left undone. One whose
-- bookkeeping fails every time used to stay there forever and take a slot in
-- every sweep's 200-object batch. This table counts the failed runs per pending
-- object; at the cap the processor parks the object under inbound/failed/ and
-- deletes the row. The storage seam has no custom object metadata to hold it.
--
-- BACK-COMPAT: new table, nothing reads it until the code that writes it ships.
-- A missing row means no failed run yet.
--
-- RETENTION: a row holds only the pending object's key (a Message-ID slug plus
-- a content digest, the same name the object already carries) and lives only
-- while that object is pending: success and parking both delete the row.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror:
-- schema/inbound_bounce_attempts.ts. Forward-only, no down.
-- =============================================================================

CREATE TABLE IF NOT EXISTS inbound_bounce_attempts (
  object_key      text        PRIMARY KEY,
  attempts        integer     NOT NULL DEFAULT 0,
  last_attempt_at timestamptz NOT NULL DEFAULT now()
);
