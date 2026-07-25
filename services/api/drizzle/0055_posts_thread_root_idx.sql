-- =============================================================================
-- 0055_posts_thread_root_idx.sql
-- -----------------------------------------------------------------------------
-- PERF (audit 2026-07-24): posts.thread_root_id is a self-FK with ON DELETE
-- CASCADE and no covering index.
--
-- 0051_social_posts.sql indexed reply_to_id and repost_of_id but not
-- thread_root_id, so every posts row DELETE (the users hard-delete cascade, test
-- teardowns, any future purge) seq-scans posts once per deleted row to find
-- cascade children. Same class as the un-indexed FKs 0037_perf_indexes_audit.sql
-- remediated elsewhere.
--
-- Partial (thread_root_id IS NOT NULL): only replies carry a thread root, and the
-- cascade lookup never probes NULL, so the index stays small.
--
-- Mirrored in src/db/schema/posts.ts.
--
-- Ordering rules: requires 0051_social_posts.sql (posts). Additive
-- IF NOT EXISTS so a partial or repeat apply is safe. Forward-only.
-- =============================================================================

CREATE INDEX IF NOT EXISTS posts_thread_root_idx
  ON posts (thread_root_id) WHERE thread_root_id IS NOT NULL;
