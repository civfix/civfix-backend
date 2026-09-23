-- =============================================================================
-- 0191_push_tokens_active_token_idx.sql
-- -----------------------------------------------------------------------------
-- The push sender revokes tokens the provider reported invalid:
--
--   UPDATE push_tokens SET revoked_at = ... WHERE token IN (...)
--     AND revoked_at IS NULL
--
-- The only token index is push_tokens_platform_token_key (platform, token), and
-- PostgreSQL 16 has no skip scan, so every prune was a sequential scan. Adding
-- the platform to the statement is not equivalent (no CHECK constrains it, and
-- a token stored under another platform would stop being pruned), so the index
-- is keyed on the token alone. Tokens are already fully indexed by the unique
-- index, so nothing new is exposed.
--
-- NOT A HOT TABLE: `push_tokens` is absent from the hot-table list in
-- docs/out-of-band-indexes.md, so this builds inline. If it has grown large by
-- the time this deploys, build it with CREATE INDEX CONCURRENTLY first and the
-- IF NOT EXISTS guard turns this into a no-op.
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/push_tokens.ts.
--
-- Conventions: one concern per file; one transaction per file. Forward-only,
-- no down.
--
-- Ordering rules: requires 0001_core.sql (push_tokens).
-- =============================================================================

CREATE INDEX IF NOT EXISTS push_tokens_active_token_idx
  ON push_tokens (token)
  WHERE revoked_at IS NULL;
