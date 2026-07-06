
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

export function makeDb(
  databaseUrl: string,
  opts: { max?: number; statementTimeoutMs?: number; idleInTxTimeoutMs?: number } = {},
): DbHandle {
  if (!databaseUrl) {
    throw new Error("makeDb: databaseUrl is required")
  }
  const statementTimeoutMs = opts.statementTimeoutMs ?? 15_000
  const idleInTxTimeoutMs = opts.idleInTxTimeoutMs ?? 30_000
  const connection: Record<string, string> = {}
  if (statementTimeoutMs > 0) connection.statement_timeout = String(statementTimeoutMs)
  if (idleInTxTimeoutMs > 0) {
    connection.idle_in_transaction_session_timeout = String(idleInTxTimeoutMs)
  }
  const common = {
    connect_timeout: 10,
    idle_timeout: 60,
    max_lifetime: 60 * 30,
    onnotice: () => {},
    ...(Object.keys(connection).length > 0 ? { connection } : {}),
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
