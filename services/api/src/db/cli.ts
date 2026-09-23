import { fileURLToPath } from "node:url"
import type { Db, Sql } from "./client.js"
import { makeDb } from "./client.js"
import { loadEnv } from "../env.js"

export async function runDbCli(
  body: (db: Db, sql: Sql) => Promise<void>,
  opts: { max?: number } = {},
): Promise<void> {
  const env = loadEnv()
  const handle = makeDb(env.DATABASE_URL, {
    max: opts.max ?? 1,
    statementTimeoutMs: 0,
    idleInTxTimeoutMs: 0,
  })
  try {
    await body(handle.db, handle.sql)
  } finally {
    await handle.close()
  }
}

export function isMainModule(importMetaUrl: string): boolean {
  return process.argv[1] !== undefined && fileURLToPath(importMetaUrl) === process.argv[1]
}

export function runIfMain(importMetaUrl: string, label: string, main: () => Promise<void>): void {
  if (!isMainModule(importMetaUrl)) return
  main().catch((err: unknown) => {
    console.error(`${label}: failed`)
    console.error(err)
    process.exit(1)
  })
}
