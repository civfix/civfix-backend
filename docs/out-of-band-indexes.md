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
sudo -n docker exec compose-api-1 node dist/db/backfill-user-activity.js
```

Verify:

```sql
\d users
EXPLAIN (COSTS OFF)
SELECT id FROM users
WHERE last_activity_geom IS NOT NULL AND deleted_at IS NULL
ORDER BY last_activity_geom <-> ST_SetSRID(ST_MakePoint(-118.24, 34.05), 4326)
LIMIT 200;
```

The plan must show `Index Scan using users_last_activity_gist`. Both index
names appear in `services/api/src/services/social-repository.drizzle.ts` and in
the integration test `test/integration/suggest-follows-pg.test.ts`, which
builds them itself (non-concurrently, on an empty testcontainer) and asserts
the planner picks them.

## Done

_(none yet — move an entry here, with the date it was built on prod, once
`\d <table>` confirms the index exists.)_
