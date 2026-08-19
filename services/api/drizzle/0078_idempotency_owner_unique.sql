-- =============================================================================
-- 0078_idempotency_owner_unique.sql
-- -----------------------------------------------------------------------------
-- FINDING F028: idempotency_keys is keyed by `key` ALONE (the PK, 0001_core.sql),
-- so a client-chosen idempotency key is global across scope AND identity. Two
-- consequences: (1) the same key reused in a different scope collides; (2) one
-- actor can pre-insert a victim's key and squat it — a DoS on report create. The
-- fix scopes uniqueness to (key, scope, owner). Add the composite UNIQUE index
-- FIRST (this file); 0079 drops the old key-only PK afterward so new code can
-- target the composite while the widening lands non-destructively.
--
-- COALESCE(user_or_anon, '') IS LOAD-BEARING: user_or_anon is nullable, and in
-- Postgres a plain multi-column UNIQUE treats NULLs as distinct — two anonymous
-- rows with the SAME (key, scope) and NULL owner would BOTH be admitted,
-- reopening the squat. Folding NULL to '' makes the identity dimension total so
-- unowned rows collide correctly.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/idempotency.ts
-- (the composite unique is an EXPRESSION index over COALESCE(...); expressed via
-- sql in the mirror the same way lower(email) is).
--
-- Conventions: additive CREATE UNIQUE INDEX IF NOT EXISTS; one transaction per
-- file; non-CONCURRENTLY build accepted (pre-launch, trivial rows). Forward-only.
--
-- Ordering rules: requires 0001_core.sql (idempotency_keys).
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idempotency_key_scope_owner_uk
  ON idempotency_keys (key, scope, COALESCE(user_or_anon, ''));
