-- =============================================================================
-- 0038_moderation_open_unique.sql
-- -----------------------------------------------------------------------------
-- F34: a partial UNIQUE index that makes "at most one OPEN moderation item per
-- (subject_type, subject_id)" a database invariant, so the createItem dedupe is
-- race-safe (the SELECT-then-INSERT check is now backstopped by ON CONFLICT DO
-- NOTHING against this index) instead of relying on READ COMMITTED timing.
--
-- Collapse any pre-existing duplicate OPEN rows first (keep the earliest) so the
-- unique index can build; on a fresh DB these DELETEs are no-ops.
-- =============================================================================

DELETE FROM moderation_items a
USING moderation_items b
WHERE a.status = 'open'
  AND b.status = 'open'
  AND a.subject_type = b.subject_type
  AND a.subject_id = b.subject_id
  AND (a.created_at > b.created_at OR (a.created_at = b.created_at AND a.id > b.id));

CREATE UNIQUE INDEX IF NOT EXISTS moderation_items_open_subject_key
  ON moderation_items (subject_type, subject_id)
  WHERE status = 'open';
