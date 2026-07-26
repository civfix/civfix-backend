-- -----------------------------------------------------------------------------
-- 0060_moderation_subject_post
--
-- Widen moderation_items.subject_type by one value: 'post'.
--
-- A social feed post was the only user-generated content in civfix with no
-- "Report" path. Every other UGC surface (report, chat/dm message, event,
-- profile, photo) files into this queue; posts could not, because
-- ContentReportSubject had no member for them and this CHECK would have
-- rejected the row even if it did.
--
-- Filing posts under the existing 'comment' was NOT an option: 'comment' is the
-- (now inert) per-report discussion subject, and the queue resolves a subject's
-- author and its takedown target per type -- a post filed as a comment would
-- resolve to no author and could not be removed.
--
-- subject_id stays uuid NOT NULL: posts.id is a uuid like every other subject.
--
-- Mirrors src/db/schema/types.ts (MODERATION_SUBJECT_TYPE_VALUES) and the shared
-- ModerationSubjectType / ContentReportSubject enums. Three guards cover this:
-- test/unit/enums.test.ts (shared <-> types.ts) and
-- test/integration/schema.test.ts (types.ts <-> this DDL CHECK, value-set AND
-- order-insensitive), which is what caught the missing migration.
--
-- The 0024 precedent applies: the inline CHECK from 0007_admin_phase2.sql is
-- unnamed, so Postgres assigned the conventional auto-name. Drop + re-add.
-- Widening a CHECK only ACCEPTS more rows, so no existing row can violate it and
-- the re-add needs no validation pass over the table.
-- -----------------------------------------------------------------------------

ALTER TABLE moderation_items
  DROP CONSTRAINT IF EXISTS moderation_items_subject_type_check;
ALTER TABLE moderation_items
  ADD CONSTRAINT moderation_items_subject_type_check
  CHECK (subject_type IN (
    'report', 'user', 'chat', 'comment', 'message', 'event', 'profile', 'photo', 'post'
  ));
