-- =============================================================================
-- 0220_runtime_flags.sql
-- -----------------------------------------------------------------------------
-- Runtime flags (DECISIONS §65 in @civfix/contract, epic #244): values an
-- operator changes from the developer console without a deploy. The list of
-- flags, their types, defaults and env fallbacks is RUNTIME_FLAGS in the
-- contract; this table holds only overrides.
--
-- One row per overridden flag, keyed by the registry key. A row IS the
-- override: clearing it deletes the row, and the audit_log row written in the
-- same transaction (action `dev.flag_set`, meta { from, to }) keeps the
-- history. Without a row the API resolves the flag's env fallback, then its
-- default, so landing this table changes nothing.
--
-- `value` is the flag's JSON value (boolean or string), checked against the
-- flag's schema on every write and on every read; a row whose key is not in
-- the registry, or whose value fails its schema, is ignored and logged, so
-- there is no DB CHECK on it.
--
-- updated_by is the operator who last set the override. It is deliberately
-- NOT a FK to users (as forward_template_settings.updated_by): the override
-- must survive the operator's account being deleted.
--
-- The API reads every row in one query and caches it for 5 seconds per
-- process, so the table needs no index beyond its primary key.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS makes re-applying a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS runtime_flags (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL
);
