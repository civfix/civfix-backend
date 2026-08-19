/**
 * Drift guard: NO migration file may contain a transaction-control statement.
 *
 * src/db/migrate.ts:83-97 owns the transaction. It reserves a connection, drives `begin` explicitly,
 * runs the file, INSERTs the _civfix_migrations bookkeeping row and `commit`s — "the DDL and its
 * bookkeeping row commit together or not at all" — with a `rollback` in the catch branch.
 *
 * A file that opens its OWN transaction breaks that invariant SILENTLY, with no error anywhere:
 *   - the file's `COMMIT;` ends the runner's transaction mid-flight;
 *   - the bookkeeping INSERT then runs in autocommit, on its own;
 *   - the runner's trailing `commit` only warns "there is no transaction in progress";
 *   - and the catch branch's `rollback` becomes a no-op, so a half-applied file is recorded as applied.
 *
 * Zero of the migrations on disk contain one today. This test is what keeps that true — copying a DDL
 * snippet out of a design doc or a Stack Overflow answer is exactly how the first one would arrive.
 *
 * No database needed: this reads the real drizzle/ directory as text.
 */

import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { orderMigrationFiles } from "../../src/db/migrate-files.js"

/** Absolute path to services/api/drizzle, resolved from this test file (cwd-independent). */
const DRIZZLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle")

/**
 * Transaction-control keywords, matched as whole words at the start of a statement. `-- NO BEGIN; HERE`
 * style banner comments are common and legitimate, so comment lines are stripped before matching.
 */
const TXN_KEYWORDS = ["begin", "commit", "rollback", "start transaction", "savepoint"] as const

/** Drop `-- line comments` and block comments so a banner explaining the rule does not trip it. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ")
}

/**
 * Drop dollar-quoted bodies (a PL/pgSQL DO block or function body). Their BEGIN/END are block
 * structure, and transaction-control statements are illegal inside one, so a partition-window
 * loop (DO $ DECLARE ...; BEGIN ... END $) must not read as opening a txn.
 */
function stripDollarQuoted(sql: string): string {
  return sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, " ")
}

describe("migrations contain no transaction-control statements", () => {
  const files = orderMigrationFiles(readdirSync(DRIZZLE_DIR))

  it("finds the migration files at all (a broken path would vacuously pass)", () => {
    expect(files.length).toBeGreaterThan(60)
  })

  it.each(files)("%s drives no BEGIN / COMMIT / ROLLBACK of its own", (name) => {
    const body = stripDollarQuoted(stripSqlComments(readFileSync(join(DRIZZLE_DIR, name), "utf8"))).toLowerCase()
    for (const keyword of TXN_KEYWORDS) {
      // Statement-initial only: `;`/newline/start-of-file, then the keyword as a whole word. This keeps
      // identifiers that merely contain the word (a `commit_at` column, `rollback_reason`) legal.
      const re = new RegExp(String.raw`(^|;)\s*${keyword}\b`)
      expect(
        re.test(body),
        `${name} contains a "${keyword}" statement — src/db/migrate.ts owns the transaction (see this file's header)`,
      ).toBe(false)
    }
  })
})
