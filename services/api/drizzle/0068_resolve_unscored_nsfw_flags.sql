-- =============================================================================
-- 0068_resolve_unscored_nsfw_flags.sql
-- -----------------------------------------------------------------------------
-- FINDING F076 (critical) — recovery migration. The media pipeline's "unscored"
-- branch was pushing an abuse_flags row (source='worker', reason='nsfw') for
-- media it could not actually score, and the anon hold-release gate counts OPEN
-- worker flags: every already-held anon report therefore stays held forever with
-- no moderator able to clear a verdict that was never really made. The code half
-- (media-worker) stops raising that flag on the unscored path; this migration
-- clears the flags already stranded in prod so the drain sweep can release them.
--
-- WHY THIS IS SAFE: no NSFW scorer is vendored in this deployment, so a
-- worker-raised 'nsfw' flag is never a real content verdict — it is only ever the
-- artifact of the unscored branch this release removes. The genuine fail-closed
-- control for un-inspectable media is the media STATUS (held/rejected), which is
-- untouched here; resolving these flags does not publish anything the status gate
-- still holds. Resolving (not deleting) preserves the audit row.
--
-- Data-only, bounded by abuse_flags size (trivial pre-launch). Idempotent: a
-- second run matches zero rows (all such flags already carry resolved_at).
--
-- CANONICAL DDL: hand-authored source of truth. No schema shape change → no
-- Drizzle mirror change (abuse_flags mirror is schema/moderation.ts).
--
-- Conventions: one transaction per file (src/db/migrate.ts). Forward-only, no down.
--
-- Ordering rules: requires 0001_core.sql (abuse_flags).
-- =============================================================================

UPDATE abuse_flags
SET resolved_at = now()
WHERE source = 'worker'
  AND reason = 'nsfw'
  AND resolved_at IS NULL;
