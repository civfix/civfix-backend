import { fileURLToPath } from "node:url"
import type { Db, Sql } from "./client.js"
import { makeDb } from "./client.js"
import { loadEnv } from "../env.js"

const DEFAULT_CLI_POOL_MAX = 1
const EXIT_FAILURE = 1

export const EXIT_USAGE = 2

/**
 * Timeouts off: these are exactly the long statements the request-path timeouts exist to kill. A
 * `databaseUrl` skips loadEnv, so the demo CLIs run from a minimal shell without the API's full env.
 */
export async function runDbCli(
  body: (db: Db, sql: Sql) => Promise<void>,
  opts: { max?: number; databaseUrl?: string } = {},
): Promise<void> {
  const databaseUrl = opts.databaseUrl ?? loadEnv().DATABASE_URL
  const handle = makeDb(databaseUrl, {
    max: opts.max ?? DEFAULT_CLI_POOL_MAX,
    statementTimeoutMs: 0,
    idleInTxTimeoutMs: 0,
  })
  try {
    await body(handle.db, handle.sql)
  } finally {
    await handle.close()
  }
}

export function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL is required")
  return databaseUrl
}

export function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

function isMainModule(importMetaUrl: string): boolean {
  return process.argv[1] !== undefined && fileURLToPath(importMetaUrl) === process.argv[1]
}

export function runIfMain(importMetaUrl: string, label: string, main: () => Promise<void>): void {
  if (!isMainModule(importMetaUrl)) return
  main().catch((err: unknown) => {
    console.error(`${label}: failed`)
    console.error(err)
    process.exit(EXIT_FAILURE)
  })
}
