-- =============================================================================
-- 0085_user_blocks_blocker_created_idx.sql
-- -----------------------------------------------------------------------------
-- FINDING F014: GET /me/blocks (the block list a user manages to unblock people)
-- pages a blocker's blocks newest-first with the house keyset cursor. user_blocks
-- has PK(blocker_id, blocked_id) and an index on blocked_id ("who blocked me"),
-- but nothing keyed for (blocker_id, created_at DESC), so the list sorts at scan
-- time and, unbounded, is a safety hazard (a user can't see/undo blocks the server
-- still enforces). Add the keyset index; social orders by exactly
-- (created_at DESC, blocked_id DESC) for the cursor and ships additive cursor
-- pagination (its half).
--
-- CANONICAL DDL: hand-authored source of truth. Mirror: schema/user_blocks.ts.
--
-- Conventions: additive CREATE INDEX IF NOT EXISTS; one transaction per file;
-- non-CONCURRENTLY build accepted (pre-launch, trivial rows). Forward-only, no down.
--
-- Ordering rules: requires 0009_dm_and_privacy.sql (user_blocks).
-- =============================================================================

CREATE INDEX IF NOT EXISTS user_blocks_blocker_created_idx
  ON user_blocks (blocker_id, created_at DESC, blocked_id DESC);
