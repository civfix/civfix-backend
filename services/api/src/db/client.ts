import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema/index.js"

export type Sql = ReturnType<typeof postgres>
export type TransactionSql = postgres.TransactionSql
export type Queryable = Sql | TransactionSql
export type Db = ReturnType<typeof drizzle<typeof schema>>

export interface DbHandle {
  db: Db
  sql: Sql
  close(): Promise<void>
}

/** `false` = plaintext, for dev and testcontainers only. */
export type DbSslOption = false | "require" | "verify-full" | { rejectUnauthorized: true }

/**
 * postgres.js defaults `ssl` to false, so a URL that merely looks secure would still ship credentials in
 * cleartext; it reads `sslmode` itself only silently. Resolving it here makes the mapping explicit and
 * testable. `prefer`/`allow`/`disable`/absent stay plaintext on purpose for loopback dev and test
 * containers; production never reaches that branch because loadEnv refuses a non-TLS sslmode.
 */
export function sslOptionForUrl(databaseUrl: string): DbSslOption {
  let mode: string | null = null
  try {
    mode = new URL(databaseUrl).searchParams.get("sslmode")
  } catch {
    // An unparseable URL cannot connect at all, and loadEnv has already vetted production's sslmode.
    mode = null
  }
  switch (mode?.trim().toLowerCase()) {
    case "verify-full":
      return "verify-full"
    // verify-ca (verified chain, no hostname check) has no named postgres.js mode, so it is expressed
    // as the equivalent tls option.
    case "verify-ca":
      return { rejectUnauthorized: true }
    case "require":
      return "require"
    default:
      return false
  }
}

export function makeDb(
  databaseUrl: string,
  opts: {
    max?: number
    statementTimeoutMs?: number
    idleInTxTimeoutMs?: number
    ssl?: DbSslOption
  } = {},
): DbHandle {
  if (!databaseUrl) {
    throw new Error("makeDb: databaseUrl is required")
  }
  const statementTimeoutMs = opts.statementTimeoutMs ?? 15_000
  const idleInTxTimeoutMs = opts.idleInTxTimeoutMs ?? 30_000
  const connection: Record<string, string> = { TimeZone: "UTC" }
  if (statementTimeoutMs > 0) connection.statement_timeout = String(statementTimeoutMs)
  if (idleInTxTimeoutMs > 0) {
    connection.idle_in_transaction_session_timeout = String(idleInTxTimeoutMs)
  }
  const common = {
    // Explicit on both clients: postgres.js's default is plaintext, so this is the single place TLS is
    // decided for every query the API and the raw repositories make.
    ssl: opts.ssl ?? sslOptionForUrl(databaseUrl),
    connect_timeout: 10,
    idle_timeout: 60,
    max_lifetime: 60 * 30,
    onnotice: () => {},
    connection,
  }
  const sql = postgres(databaseUrl, { ...common, max: opts.max ?? 10 })
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
