-- =============================================================================
-- 0059_users_follow_counters.sql
-- -----------------------------------------------------------------------------
-- PERFORMANCE (audit 2026-07-24 wave 2, services-core-1 #13): every people-facing
-- read projected a person's follower/following totals as TWO correlated count(*)
-- subqueries over follows_people. Wave 1 made them cheap per PAGE rather than per
-- matched row (the post feed aggregates once over the page's author ids; people
-- search and the follower/following rosters cut the page FIRST and hydrate the
-- limit+1 survivors), but the work is still O(edges of every person on the page)
-- on every single render, and one popular account's roster is unbounded. This is
-- the durable fix: two denormalized counters on users, maintained in the same
-- transaction as the edge write.
--
-- SEMANTICS - edges to/from SOFT-DELETED users COUNT. That is exactly what the
-- aggregates being replaced did: `count(*) FROM follows_people WHERE followee_id
-- = u.id` never joined users, and account deletion is a TOMBSTONE (users.deleted_at
-- + anonymize, see deleteAccount in src/routes/users.routes.ts) that leaves
-- follows_people untouched. Consequence, preserved deliberately rather than
-- changed under a perf refactor: a person's follower_count can exceed the length
-- of their visible followers roster, because the roster filters
-- `u.deleted_at IS NULL` and the count never did. addFollow/removeFollow both
-- refuse a soft-deleted followee, so no NEW tombstone edge can appear and an
-- existing one can never be removed.
--
-- MAINTENANCE is application-side, in the same transaction as the edge write
-- (addFollow / removeFollow in src/services/social-repository.drizzle.ts),
-- mirroring the posts.like_count / repost_count / reply_count pattern already in
-- 0051_social_posts.sql + post-repository.drizzle.ts: the INSERT is
-- `ON CONFLICT DO NOTHING RETURNING` and the DELETE is `RETURNING`, so the
-- counters move ONLY when a row actually changed - an idempotent re-follow or
-- re-unfollow is a no-op, not a double count. There is deliberately NO trigger,
-- so anything writing follows_people outside those two methods (a psql session, a
-- test fixture, a future bulk import) must bump the counters too, or the drift
-- query in the operator runbook has to be run afterwards.
--
-- No CHECK (count >= 0): the decrements clamp with GREATEST(x - 1, 0), exactly
-- like the post counters, so a maintenance bug surfaces as a stale number rather
-- than a 500 on the follow button - and the drift query is the detector.
--
-- Conventions (match the rest of the suite): additive, IF NOT EXISTS, forward-only
-- (there is no down migration). The runner (src/db/migrate.ts) sorts drizzle/*.sql
-- lexically, records applied files in _civfix_migrations and wraps each file in
-- ONE transaction - so the two ADD COLUMNs and the backfill either all land or
-- none do, and a repeat apply re-runs the backfill as a no-op (see the guard on
-- the UPDATE).
--
-- Lock note (read before applying to a large production users table): the two
-- ADD COLUMNs take ACCESS EXCLUSIVE on users, and because the runner wraps the
-- whole file in ONE transaction that lock is held through the backfill UPDATE
-- below - which scans all of users plus two grouped scans of follows_people.
-- ACCESS EXCLUSIVE blocks READS as well as writes, and every authenticated
-- request reads users (session lookup), so the API is effectively down for the
-- duration. The ADD COLUMNs themselves are cheap (PG 11+ stores a NOT NULL
-- DEFAULT as a table-level default instead of rewriting rows) - the backfill is
-- the whole exposure.
--
-- Escape hatch, no code change needed: run the file's two statements OUT OF BAND
-- in SEPARATE transactions before deploying (psql: the ALTER, commit, then the
-- UPDATE). The ALTER alone holds ACCESS EXCLUSIVE only for its own instant, and
-- the UPDATE alone takes just ROW EXCLUSIVE plus row locks on the rows it
-- actually changes, so concurrent reads never block. Afterwards the migration
-- itself is a no-op pair (ADD COLUMN IF NOT EXISTS on existing columns, then an
-- UPDATE whose guard matches zero rows): still one scan under ACCESS EXCLUSIVE,
-- but a read-only one that rewrites nothing, which is orders of magnitude shorter
-- than the same statement rewriting every row with edges. The same
-- split is the right way to run the drift REPAIR the operator runbook describes:
-- re-run the UPDATE statement on its own, not the file.
--
-- The full users scan is deliberate and must not be narrowed to "users that
-- appear in follows_people": the runbook advertises re-running this backfill as
-- the drift repair, and the row that most needs repairing is one whose counter is
-- non-zero while its edges are gone. An edges-only backfill would never reset it.
--
-- Ordering rules: requires 0001_core.sql (users, follows_people).
-- =============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS follower_count  int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS following_count int NOT NULL DEFAULT 0;

-- Backfill from the edge table. Both aggregates are grouped scans over indexed
-- columns (follows_people is PK(follower_id, followee_id) + the
-- follows_people_followee_idx used by the "who follows me" side), and the WHERE
-- guard means a re-apply - or an apply on a database where an earlier attempt
-- already backfilled - rewrites ZERO rows instead of the whole users table.
WITH followers_agg AS (
  SELECT followee_id AS user_id, count(*)::int AS n FROM follows_people GROUP BY followee_id
),
following_agg AS (
  SELECT follower_id AS user_id, count(*)::int AS n FROM follows_people GROUP BY follower_id
),
agg AS (
  SELECT
    u.id,
    COALESCE(fr.n, 0) AS followers,
    COALESCE(fg.n, 0) AS following
  FROM users u
  LEFT JOIN followers_agg fr ON fr.user_id = u.id
  LEFT JOIN following_agg fg ON fg.user_id = u.id
)
UPDATE users u
   SET follower_count  = agg.followers,
       following_count = agg.following
  FROM agg
 WHERE agg.id = u.id
   AND (u.follower_count <> agg.followers OR u.following_count <> agg.following);
