/**
 * Shared boilerplate for the side-effecting db/ CLI scripts (migrate, seed, ingest, backfill).
 *
 * Each script repeated the same loadEnv -> makeDb -> try/finally close -> error-exit guard. This
 * centralizes that so a script is just its label + a `(db, sql) => Promise<void>` body. The pure cores
 * (`*-core.ts`) stay separate and importable; only the entrypoints use this.
 *
 * NOTE: this module does NOT call process.exit itself except via `runIfMain`'s catch — it is safe to
 * import from a runtime module (no top-level side effects).
 */

import { fileURLToPath } from "node:url"
import type { Db, Sql } from "./client.js"
import { makeDb } from "./client.js"
import { loadEnv } from "../env.js"

/**
 * Open a DB handle from the loaded env, run `body(db, sql)`, and always close the pool. CLI scripts use
 * a tiny pool (max:1) since they are one-shot. Throws on any error so the caller's guard can exit non-zero.
 */
export async function runDbCli(
  body: (db: Db, sql: Sql) => Promise<void>,
  opts: { max?: number } = {},
): Promise<void> {
  const env = loadEnv()
  const handle = makeDb(env.DATABASE_URL, { max: opts.max ?? 1 })
  try {
    await body(handle.db, handle.sql)
  } finally {
    await handle.close()
  }
}

/** True when `importMetaUrl` is the process entrypoint (tsx src/db/x.ts / node dist/db/x.js), not an import. */
export function isMainModule(importMetaUrl: string): boolean {
  return process.argv[1] !== undefined && fileURLToPath(importMetaUrl) === process.argv[1]
}

/**
 * Run `main` only when the calling module is the process entrypoint, logging `${label}: failed` and
 * exiting non-zero on error. The standard tail of every db/ CLI script.
 */
export function runIfMain(importMetaUrl: string, label: string, main: () => Promise<void>): void {
  if (!isMainModule(importMetaUrl)) return
  main().catch((err: unknown) => {
    console.error(`${label}: failed`)
    console.error(err)
    process.exit(1)
  })
}
