/**
 * Drizzle (postgres-js) client factory.
 *
 * IMPORTANT: nothing connects at import time. `makeDb()` builds a lazily-connecting client; the
 * underlying `postgres` driver only opens a socket on first query. This lets `buildServer()` and
 * unit tests run with no DATABASE_URL when the fakes are selected.
 */

import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema/index.js"

export type Sql = ReturnType<typeof postgres>
/**
 * The transaction-scoped postgres-js tag handed to a `sql.begin(async (tx) => ...)` callback. Reads and
 * writes inside a transaction use this tag; helpers that must work both standalone and inside a
 * transaction accept `Queryable` (the union of the two).
 */
export type TransactionSql = postgres.TransactionSql
/** Either the pooled tag or a transaction-scoped tag. Use for query helpers that run in both contexts. */
export type Queryable = Sql | TransactionSql
export type Db = ReturnType<typeof drizzle<typeof schema>>

export interface DbHandle {
  /** Drizzle client bound to the civfix schema. */
  db: Db
  /** Raw postgres-js tag, exposed for migrations / LISTEN-NOTIFY / health pings. */
  sql: Sql
  /** Close the pool. Safe to call multiple times. */
  close(): Promise<void>
}

/**
 * Build a DB handle. Does not connect until the first query is issued.
 *
 * IMPORTANT — two postgres.js clients, on purpose. `drizzle(client, ...)` REPLACES postgres.js's value
 * serializers (Date, json/jsonb, arrays, ...) with identity passthroughs, because Drizzle pre-serializes
 * values in its own column layer. That is correct for the Drizzle query builder (`db`), but it BREAKS
 * the hand-written SQL in the raw-`sql` repositories, which pass real JS values (a `Date`, a plain
 * object for a jsonb column, ...) and rely on postgres.js converting them — otherwise postgres.js hands
 * the raw value to its byte writer and Node throws `ERR_INVALID_ARG_TYPE` ("Received an instance of
 * Date/Object"). So Drizzle gets its OWN client; the raw `sql` client is never wrapped and keeps
 * postgres.js's full default serialization. The two are separate pools to the same database.
 * (See drizzle-orm#3108.)
 *
 * @param databaseUrl postgres connection string (postgres://...).
 * @param opts.max    max pool connections for the raw `sql` client (default 10).
 */
export function makeDb(databaseUrl: string, opts: { max?: number } = {}): DbHandle {
  if (!databaseUrl) {
    throw new Error("makeDb: databaseUrl is required")
  }
  const common = {
    // Fail fast rather than hanging forever if the host is unreachable.
    connect_timeout: 10,
    // Close idle sockets after 60s so a NAT/firewall/managed-PG idle reaper can't drop one under us and
    // resurface as a stale-connection error on the next query; recycle every 30min as a backstop.
    idle_timeout: 60,
    max_lifetime: 60 * 30,
    // Let the app own its lifecycle/logging; keep the driver quiet by default.
    onnotice: () => {},
    // prepare defaults true — correct on a DIRECT Postgres. If a txn-mode pooler (PgBouncer/Supavisor) is
    // ever introduced, set prepare:false here or it errors with "prepared statement already exists".
  }
  // Backend budget: this factory opens TWO pools (raw max:10 + drizzle max:4 = up to 14 backends per
  // process), and the media-worker opens its own pair via @civfix/api/db. Size N replicas + the worker
  // against Postgres max_connections (≈100) and leave headroom.
  // Raw client for the hand-written SQL repositories (PostGIS / transactional SQL). Full default value
  // serialization — NEVER passed to drizzle (see the note above).
  const sql = postgres(databaseUrl, { ...common, max: opts.max ?? 10 })
  // Drizzle's OWN client (small pool — only the media/auth `db`-repositories use the query builder), so
  // its serializer reconfiguration never leaks onto `sql`.
  const drizzleSql = postgres(databaseUrl, { ...common, max: 4 })
  const db = drizzle(drizzleSql, { schema })

  let closed = false
  async function close(): Promise<void> {
    if (closed) return
    closed = true
    await Promise.all([sql.end({ timeout: 5 }), drizzleSql.end({ timeout: 5 })])
  }

  return { db, sql, close }
}
