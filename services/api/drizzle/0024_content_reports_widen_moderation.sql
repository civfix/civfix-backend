-- -----------------------------------------------------------------------------
-- 0024_content_reports_widen_moderation
--
-- App-Store-audit remediation: user-facing "Report" buttons across the UGC
-- surfaces file into the SAME admin moderation queue (moderation_items) the
-- operator already reads. That requires widening two CHECK constraints:
--
--   * kind          += 'user_report'   (a citizen-filed abuse report, distinct
--                                        from the automated image/pattern/gps/
--                                        duplicate kinds + the appeal kind).
--   * subject_type  += 'comment','message','event','profile','photo'
--                                       (the reportable UGC subjects; the
--                                        existing report/user/chat stay valid).
--
-- subject_id remains uuid NOT NULL — every reportable id in civfix is a uuid
-- (report, discussion comment, chat/dm message, cleanup event, user profile,
-- media photo), so no column-type change is needed.
--
-- The inline CHECKs in 0007_admin_phase2.sql are unnamed, so Postgres assigned
-- the conventional auto-names moderation_items_kind_check /
-- moderation_items_subject_type_check. Drop + re-add with the widened IN lists.
-- Mirrors src/db/schema/types.ts (MODERATION_KIND_VALUES /
-- MODERATION_SUBJECT_TYPE_VALUES) and the shared ModerationKind /
-- ModerationSubjectType enums (guarded by test/unit/enums.test.ts).
-- -----------------------------------------------------------------------------

ALTER TABLE moderation_items
  DROP CONSTRAINT IF EXISTS moderation_items_kind_check;
ALTER TABLE moderation_items
  ADD CONSTRAINT moderation_items_kind_check
  CHECK (kind IN ('image', 'pattern', 'appeal', 'gps', 'duplicate', 'user_report'));

ALTER TABLE moderation_items
  DROP CONSTRAINT IF EXISTS moderation_items_subject_type_check;
ALTER TABLE moderation_items
  ADD CONSTRAINT moderation_items_subject_type_check
  CHECK (subject_type IN (
    'report', 'user', 'chat', 'comment', 'message', 'event', 'profile', 'photo'
  ));
