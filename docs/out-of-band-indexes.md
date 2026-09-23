# Out-of-band indexes (civfix-backend)

**Audience:** internal (engineering + ops). Not served publicly.
**Last updated:** 2026-09-02 (audit H18).

Every migration in `services/api/drizzle/` runs inside **one transaction**
(`src/db/migrate.ts`), and `CREATE INDEX CONCURRENTLY` is not allowed in a
transaction block. A plain `CREATE INDEX` on a hot table (`users`, `reports`,
`chat_messages`, `dm_messages`, `media_assets`, `notifications`, `sessions`)
holds `ACCESS EXCLUSIVE` for the whole build and queues live traffic behind it.

So: **hot-table indexes are built out of band, by hand, against the live
database, before or right after the deploy that needs them.** The migration
that introduces the query path carries only an idempotent guard that logs a
`WARNING` while the index is missing. Nothing breaks without the index — the
queries stay correct, they just fall back to a sequential scan.

Run each command **outside** any transaction (a bare `psql` session is already
outside one; do not wrap it in `BEGIN`). `CONCURRENTLY` builds do not block
reads or writes, take roughly two table passes, and leave an `INVALID` index
behind if interrupted — re-run `DROP INDEX CONCURRENTLY IF EXISTS <name>;` then
the create again if `\d users` shows one.

```sh
ssh civfix
sudo -n docker exec -it compose-postgres-1 psql -U civfix -d civfix
```

## Pending

### `users_last_activity_gist` + `users_last_activity_at_idx` (migration 0102, audit H18)

Back the bounded candidate scan in `suggestFollows`
(`services/api/src/services/social-repository.drizzle.ts`): a KNN
`ORDER BY last_activity_geom <-> <viewer point> LIMIT K` for viewers with a
location, and a `last_activity_at DESC LIMIT K` recency pool for viewers
without one.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS users_last_activity_gist
  ON users USING gist (last_activity_geom)
  WHERE last_activity_geom IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS users_last_activity_at_idx
  ON users (last_activity_at DESC)
  WHERE last_activity_at IS NOT NULL AND deleted_at IS NULL;
```

Then backfill the two columns for existing rows (keyset-paged, idempotent,
safe to re-run and safe to run while the API serves traffic):

```sh
sudo -n docker exec $(sudo docker ps --format '{{.Names}}' | grep -m1 -E 'compose-api-(blue|green)') node dist/db/backfill-user-activity.js
```

Verify — **against the real statement, with a viewer point that is an outer
reference, not a constant**. A constant-point `EXPLAIN` is not a valid check
here: Postgres builds the KNN (`amcanorderbyop`) path only when the non-indexed
operand of `<->` is Var-free, so a hand-written query with a literal point
reports a KNN scan even when the shipped query cannot use one. Reproduce the
lateral the repository emits:

```sql
\d users

EXPLAIN (COSTS OFF, VERBOSE)
WITH viewer_point AS (
  SELECT ST_SetSRID(ST_MakePoint(-118.24, 34.05), 4326) AS geom
)
SELECT n.id
FROM viewer_point vp
CROSS JOIN LATERAL (
  SELECT u.id
  FROM users u
  WHERE u.deleted_at IS NULL
    AND u.handle IS NOT NULL
    AND u.last_activity_geom IS NOT NULL
    AND ST_DWithin(u.last_activity_geom, vp.geom, 2.5)
  ORDER BY u.last_activity_geom <-> vp.geom
  LIMIT 200
) n;
```

The plan must show `Index Scan using users_last_activity_gist` **with an
`Order By:` line under it** — that line is what distinguishes a KNN scan that
stops at `LIMIT 200` from a box scan of the whole 2.5° radius followed by a
top-N sort. `Index Cond:` alone is the degraded plan.

The equivalent recency check:

```sql
EXPLAIN (COSTS OFF)
SELECT id FROM users
WHERE last_activity_at IS NOT NULL AND deleted_at IS NULL
ORDER BY last_activity_at DESC
LIMIT 200;
```

Both index names are exported from
`services/api/src/services/social-repository.drizzle.ts` and asserted by
`test/integration/suggest-follows-pg.test.ts`, which builds the indexes itself
(non-concurrently, on an empty testcontainer) and `EXPLAIN`s the **actual**
statement through the exported `explainSuggestFollows`. The offline half —
that the emitted SQL really is a `CROSS JOIN LATERAL` and not a same-level
cross join — is `test/unit/social-suggest-sql.test.ts`.

### `posts.geom` backfill (migration 0176, issue #100) — data, not an index

`posts` is NOT a hot table, so `posts_geom_gist` and
`posts_author_public_recent_idx` are built inline by migrations 0176 and 0177
and need nothing here. What DOES need an out-of-band run is the **backfill**:
0176 adds the column but deliberately populates no rows, because one `UPDATE`
over the whole table inside the migration's single transaction is a lock
hazard. The migration RAISEs a `WARNING` when any backfillable post is still
unpopulated.

Run it once the deploy is healthy — keyset-paged, idempotent, safe to re-run
and safe while the API serves traffic:

```sh
sudo -n docker exec $(sudo docker ps --format '{{.Names}}' | grep -m1 -E 'compose-api-(blue|green)') node dist/db/backfill-post-geom.js
```

Nothing breaks without it: a `NULL` `posts.geom` yields a `NULL` `distance_km`,
the ranker simply scores no proximity term for that post, and the in-network
and recent-public pools still fill the feed. Only the *nearby* pool is degraded.

Verify:

```sql
SELECT count(*)
  FROM posts p
  LEFT JOIN reports  r ON r.id = p.report_id
  LEFT JOIN cleanups c ON c.id = p.event_id
 WHERE p.geom IS NULL AND COALESCE(r.geom, c.geom) IS NOT NULL;
```

must return `0`. (The `COALESCE(...) IS NOT NULL` term matters: a post linked to
a row whose own `geom` is null is not backfillable, and counting it would make
this check permanently unsatisfiable. The migration's `DO` block uses the same
predicate.)

**`posts.geom` is an insert-time snapshot, not a live mirror.** It is written
once by `createPost` and never updated: there is no trigger and no relocation
hook, and the backfill only touches rows where `geom IS NULL`. If a report or
cleanup is later moved to a new coordinate, every post already linked to it
keeps ranking against the OLD point indefinitely. That is acceptable for feed
proximity (the post was about the place as it was), but it is a deliberate
property, not an oversight — if live tracking is ever wanted, the relocation
paths must update the derived posts explicitly.

If `posts` has grown large enough that an inline `CREATE INDEX` would be
disruptive, build both indexes with `CONCURRENTLY` BEFORE deploying — the
migrations' `IF NOT EXISTS` guards then no-op:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS posts_geom_gist
  ON posts USING gist (geom)
  WHERE geom IS NOT NULL AND deleted_at IS NULL AND reply_to_id IS NULL
    AND visibility = 'public';

CREATE INDEX CONCURRENTLY IF NOT EXISTS posts_author_public_recent_idx
  ON posts (author_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND reply_to_id IS NULL AND visibility = 'public';
```

The nearby pool's plan is asserted by
`test/integration/feed-ranked-pg.test.ts`, which `EXPLAIN`s the real statement
through the exported `explainFeedCandidates` and requires
`posts_geom_gist` with no `Seq Scan on posts`.

### `media_assets_orphan_sweep_idx` (migration 0098, audit H13)

Back the hourly orphan sweep's candidate scan (`findOrphans` /`deleteOrphan` in
`services/api/src/services/media-worker-repo.ts`), which looks for media rows
with no binding older than the orphan TTL. Without it every run sequentially
scans `media_assets`.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS media_assets_orphan_sweep_idx
  ON media_assets (created_at)
  WHERE report_id IS NULL
    AND chat_message_id IS NULL
    AND post_id IS NULL
    AND purpose <> 'verification';
```

Verify:

```sql
\d media_assets
EXPLAIN (COSTS OFF)
SELECT id FROM media_assets
WHERE report_id IS NULL AND chat_message_id IS NULL AND post_id IS NULL
  AND purpose <> 'verification' AND created_at < now() - interval '6 hours'
LIMIT 1000;
```

The plan must show `Index Scan using media_assets_orphan_sweep_idx`. The two
avatar `NOT EXISTS` probes are evaluated on the (now small) candidate set.

## Done

_(none yet — move an entry here, with the date it was built on prod, once
`\d <table>` confirms the index exists.)_
