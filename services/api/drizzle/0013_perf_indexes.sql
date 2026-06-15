-- =============================================================================
-- 0013_perf_indexes.sql
-- -----------------------------------------------------------------------------
-- Structural performance indexes: composite keyset, partial, and expression
-- indexes that back hot admin-list / sweep / activity queries that today fall
-- back to a Seq Scan + top-N Sort. Every index below was VERIFIED against a real
-- query in src/services (the comment on each cites the query it serves).
--
-- WHY a new file (not editing 0001/0007/0009): the migrate runner records every
-- applied file in _civfix_migrations and NEVER re-runs an edited one. Already-
-- applied DDL is immutable; new work lands in the next-numbered file.
--
-- TRANSACTION NOTE: the runner wraps each file in ONE transaction, so we cannot
-- use CREATE INDEX CONCURRENTLY here. Every statement is plain CREATE INDEX
-- IF NOT EXISTS, which is idempotent and re-apply-safe.
--
-- This file holds the structural (non-trigram) indexes. Trigram GIN search
-- indexes (which need CREATE EXTENSION pg_trgm) live in 0014_search_trgm.sql.
--
-- CANONICAL DDL: this hand-authored SQL is the source of truth. The Drizzle
-- definitions under src/db/schema mirror each index where Drizzle can express it.
--
-- Ordering rules:
--   * Requires 0001_core.sql (users, reports, cleanups, audit_log, report_timeline),
--     0002_chat_partitioning.sql (chat_messages parent), 0007_admin_phase2.sql
--     (mail_threads, mail_events), and 0009_dm_and_privacy.sql (dm_threads).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- dm_threads.user_hi  (findings 1 + 15 — SAME index, created once)
-- -----------------------------------------------------------------------------
-- listThreadsForUser / DM inbox filter `WHERE user_lo = X OR user_hi = X`. The
-- UNIQUE(user_lo, user_hi) already anchors the user_lo branch via its leftmost
-- prefix, but user_hi had NO index, forcing a full Seq Scan. This standalone
-- index lets the planner BitmapOr the two anchored index scans instead.
--   dm-repository.drizzle.ts:348, social DM inbox list.
CREATE INDEX IF NOT EXISTS dm_threads_user_hi_idx
  ON dm_threads (user_hi);

-- -----------------------------------------------------------------------------
-- reports admin keyset + status facet  (finding 2)
-- -----------------------------------------------------------------------------
-- Admin reports list paginates by (created_at DESC, id DESC) over non-deleted
-- rows. The DESC/DESC partial index lets the planner walk it for both the global
-- newest-first scan and the (created_at, id) < anchor keyset seek with no Sort.
--   admin-report-repository.drizzle.ts:170 (ORDER BY), :167 (keyset predicate).
CREATE INDEX IF NOT EXISTS reports_created_id_idx
  ON reports (created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Status-facet variant: the same list with `AND r.status = $1` (the most common
-- operator filter) is served end-to-end by leading on status.
--   admin-report-repository.drizzle.ts:149 (status filter) + :170 (ORDER BY).
CREATE INDEX IF NOT EXISTS reports_status_created_id_idx
  ON reports (status, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- users admin keyset  (finding 3)
-- -----------------------------------------------------------------------------
-- Admin users list paginates by (created_at DESC, id DESC). Matching composite
-- index turns the full Seq Scan + top-N Sort into an index range scan.
--   admin-user-repository.drizzle.ts:135 (ORDER BY), :132 (keyset predicate).
CREATE INDEX IF NOT EXISTS users_created_id_idx
  ON users (created_at DESC, id DESC);

-- -----------------------------------------------------------------------------
-- chat_messages by sender  (finding 4) — PARTITIONED PARENT
-- -----------------------------------------------------------------------------
-- listUserMessages: `WHERE m.sender_id = X ... ORDER BY m.created_at DESC, m.id DESC`.
-- chat_messages is declaratively partitioned (0002); a PLAIN index on the parent
-- propagates to every current AND future partition (no partition-key requirement
-- because this is non-unique). created_at is the partition key, so this also
-- enables per-partition pruning + ordered scan.
--   admin-user-repository.drizzle.ts:268-270.
CREATE INDEX IF NOT EXISTS chat_messages_sender_created_idx
  ON chat_messages (sender_id, created_at DESC, id DESC);

-- -----------------------------------------------------------------------------
-- reports recent public feed  (findings 5/6 reports-branch + finding 11)
-- -----------------------------------------------------------------------------
-- recentPins (`WHERE deleted_at IS NULL AND visibility = 'public' ORDER BY
-- created_at DESC NULLS LAST`) and the activity-feed report UNION branch
-- (`... ORDER BY r.created_at DESC`, same partial predicate) both want newest
-- public, non-deleted reports. This partial index makes both a bounded index scan
-- (no top-N heap Sort).
--   home-repository.drizzle.ts:216, activity-repository.drizzle.ts (report branch).
-- NOTE on NULLS direction: reports.created_at is nullable in DDL but is DEFAULT
-- now() and set on every insert, so in practice no NULL rows exist. The two
-- consumers ask for opposite NULLS ordering (recentPins NULLS LAST vs the activity
-- branch's default NULLS FIRST); we keep the index at the bare `(created_at DESC)`
-- so it serves BOTH (the NULLS direction is immaterial with no NULL rows). Pinning
-- it to either NULLS ordering would only de-optimize the other query.
CREATE INDEX IF NOT EXISTS reports_public_recent_idx
  ON reports (created_at DESC)
  WHERE deleted_at IS NULL AND visibility = 'public';

-- -----------------------------------------------------------------------------
-- cleanups created_at  (findings 5/6 cleanups-branch)
-- -----------------------------------------------------------------------------
-- Activity-feed cleanups UNION branch orders by c.created_at DESC (the COALESCE(
-- c.created_at, c.scheduled_at) wrapper has been dropped — created_at is DEFAULT
-- now() and effectively non-null, so the fallback never fired). This plain
-- (created_at DESC) index serves that sort directly. cleanups_scheduled_idx (0001)
-- already covers any scheduled_at-only ordering, so no extra index is needed for
-- the recentPins events half.
--   activity-repository.drizzle.ts (cleanup branch).
CREATE INDEX IF NOT EXISTS cleanups_created_idx
  ON cleanups (created_at DESC);

-- -----------------------------------------------------------------------------
-- audit_log created_at  (findings 5/6 audit-branch)
-- -----------------------------------------------------------------------------
-- Activity-feed audit UNION branch orders by a.created_at DESC with NO filter;
-- audit_log only had (actor_id, created_at) + (action), neither of which serves a
-- global newest-first scan. audit_log is append-only and unbounded, so this is a
-- real win. This branch's ORDER BY is already a bare column (usable immediately).
--   activity-repository.drizzle.ts:62.
CREATE INDEX IF NOT EXISTS audit_log_created_idx
  ON audit_log (created_at DESC);

-- -----------------------------------------------------------------------------
-- mail_events created_at  (findings 5/6 mail_events-branch)
-- -----------------------------------------------------------------------------
-- Activity-feed mail_events UNION branch orders by e.created_at DESC.
-- mail_events_type_created_idx leads on `type`, so it cannot serve a global
-- created_at DESC scan. Append-only + unbounded -> add the single-column index.
--   activity-repository.drizzle.ts:94.
CREATE INDEX IF NOT EXISTS mail_events_created_idx
  ON mail_events (created_at DESC);

-- -----------------------------------------------------------------------------
-- audit_log keyset list  (finding 9)
-- -----------------------------------------------------------------------------
-- The admin audit list paginates by (created_at DESC, id DESC) with an unfiltered
-- keyset predicate. Composite index = index range scan instead of Seq Scan + Sort.
--   audit-repository.drizzle.ts:78 (ORDER BY), :53 (keyset predicate).
CREATE INDEX IF NOT EXISTS audit_log_created_id_idx
  ON audit_log (created_at DESC, id DESC);

-- -----------------------------------------------------------------------------
-- audit_log (action, target) reads  (finding 10)
-- -----------------------------------------------------------------------------
-- listNotes / listContactSuggestions filter `WHERE action = $1 AND target = $2
-- ORDER BY created_at ASC`. Only `action` was indexed. The composite resolves the
-- (action, target) equality and satisfies the created_at ordering with no Sort.
--   discovery-repository.drizzle.ts:241-243 and :263-265.
CREATE INDEX IF NOT EXISTS audit_log_action_target_created_idx
  ON audit_log (action, target, created_at);

-- -----------------------------------------------------------------------------
-- report_timeline acknowledged lookup  (finding 12)
-- -----------------------------------------------------------------------------
-- The jurisdiction-directory `last_routed_at` correlated subquery does
-- `MAX(rt.created_at) WHERE r.jurisdiction_geoid = $1 AND rt.status =
-- 'acknowledged'`. A partial index on (report_id, created_at) for acknowledged
-- rows lets the nested loop read only acknowledged timeline rows per report
-- instead of heap-filtering status.
--   jurisdiction-contacts-repository.drizzle.ts:287.
CREATE INDEX IF NOT EXISTS report_timeline_acknowledged_idx
  ON report_timeline (report_id, created_at)
  WHERE status = 'acknowledged';

-- -----------------------------------------------------------------------------
-- mail_threads inbox keyset  (finding 13) — EXPRESSION index
-- -----------------------------------------------------------------------------
-- listThreads paginates by (COALESCE(last_message_at, created_at) DESC, id DESC)
-- so a brand-new thread with no message still orders by its creation time. An
-- expression index on exactly that key lets the keyset cursor do an index range
-- scan instead of Seq Scan + in-memory Sort.
--   mail-repository.drizzle.ts:570 (ORDER BY), :523 (keyset predicate).
CREATE INDEX IF NOT EXISTS mail_threads_inbox_keyset_idx
  ON mail_threads ((COALESCE(last_message_at, created_at)) DESC, id DESC);

-- -----------------------------------------------------------------------------
-- reports held-anon release sweep  (finding 14)
-- -----------------------------------------------------------------------------
-- findHeldAnonReportIds: `WHERE status = 'held' AND reporter_user_id IS NULL AND
-- deleted_at IS NULL ORDER BY created_at ASC LIMIT n`. A partial index that
-- exactly matches the filter and is ordered by created_at serves the LIMIT via an
-- ordered index scan with no Sort and no held-row heap visibility churn.
--   anon-hold-release-repo.drizzle.ts:104-111.
CREATE INDEX IF NOT EXISTS reports_held_anon_created_idx
  ON reports (created_at)
  WHERE status = 'held' AND reporter_user_id IS NULL AND deleted_at IS NULL;
