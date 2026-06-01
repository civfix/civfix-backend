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
 * @param databaseUrl postgres connection string (postgres://...).
 * @param opts.max    max pool connections (default 10).
 */
export function makeDb(databaseUrl: string, opts: { max?: number } = {}): DbHandle {
  if (!databaseUrl) {
    throw new Error("makeDb: databaseUrl is required")
  }
  const sql = postgres(databaseUrl, {
    max: opts.max ?? 10,
    // Fail fast rather than hanging forever if the host is unreachable.
    connect_timeout: 10,
    // Let the app own its lifecycle/logging; keep the driver quiet by default.
    onnotice: () => {},
  })
  const db = drizzle(sql, { schema })

  let closed = false
  async function close(): Promise<void> {
    if (closed) return
    closed = true
    await sql.end({ timeout: 5 })
  }

  return { db, sql, close }
}
