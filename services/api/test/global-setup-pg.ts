/**
 * vitest globalSetup: ONE PostGIS container for the whole run.
 *
 * The container starts once, the migrations + seed are applied once into a TEMPLATE database, and each
 * test file clones that template into its own database (see test/helpers/pg.ts). A file still gets a
 * private database nothing else writes to, but pays for a clone instead of a container boot plus every
 * migration.
 *
 * On a DEVELOPER MACHINE a failed container start is reported to the workers as `unavailable` (never
 * thrown), withPg() then returns null, and `describe.skipIf(!pg)` keeps the suite green with no Docker.
 * In CI (or under CIVFIX_REQUIRE_PG) startSharedPg THROWS instead, so a broken Docker socket fails the run
 * rather than silently dropping the integration suite from a green build (see assertPgSkipAllowed in
 * helpers/pg-container.ts). A migrations/seed failure always throws: that is a real error, not a skip.
 *
 * This file runs in vitest's main process, NOT in a worker: it must not import the `vitest` entrypoint
 * (directly or transitively), hence the split into pg-container.ts / pg-selection.ts.
 */

import { readFile, readdir } from "node:fs/promises"
import { join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { GlobalSetupContext } from "vitest/node"
import { startSharedPg, type SharedPg } from "./helpers/pg-container.js"
import { cliFileFilters, selectSharedPgStart } from "./helpers/pg-selection.js"

/** What the workers read back via `inject("civfixPg")` (see test/helpers/pg.ts). */
export type ProvidedPg =
  /** Container is up: clone `templateDb` over the maintenance connection `adminUri`. */
  | { kind: "ready"; adminUri: string; templateDb: string }
  /** Docker is unavailable: tests must SKIP (describe.skipIf(!pg)). */
  | { kind: "unavailable"; reason: string }
  /** No pg-using test file appeared to be selected, so nothing was started. withPg() may boot its own. */
  | { kind: "not-started"; reason: string }

const TEST_ROOT = fileURLToPath(new URL(".", import.meta.url))

let shared: SharedPg | undefined

/** Every `*.test.ts` under test/ (absolute paths): the population vitest's CLI filters select from. */
async function listTestFiles(): Promise<string[]> {
  const entries = await readdir(TEST_ROOT, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
    .map((e) => join(e.parentPath, e.name))
}

/**
 * Any import of the harness module, at any relative depth: `../helpers/pg.js` from test/integration,
 * `./pg.js` from a test that lives beside it in test/helpers.
 */
const PG_HARNESS_IMPORT = /from\s*["'][^"']*\/pg\.js["']/

/**
 * True when a test file needs the harness: it imports it, or it lives in test/integration (where every
 * file is Docker-gated; the belt to the import-check's braces, so a helper that starts importing the
 * harness on a file's behalf cannot make this answer "no").
 */
async function usesPgHarness(file: string): Promise<boolean> {
  if (file.includes(`${sep}integration${sep}`)) return true
  const source = await readFile(file, "utf8").catch(() => "")
  return PG_HARNESS_IMPORT.test(source)
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const files = await listTestFiles()
  // Pre-resolve the predicate (selectSharedPgStart is sync/pure so it can be unit-tested).
  const pgFiles = new Set<string>()
  const flags = await Promise.all(files.map((f) => usesPgHarness(f)))
  files.forEach((f, i) => {
    if (flags[i] === true) pgFiles.add(f)
  })

  const decision = selectSharedPgStart(cliFileFilters(process.argv.slice(2)), files, (f) =>
    pgFiles.has(f),
  )
  if (!decision.start) {
    provide("civfixPg", { kind: "not-started", reason: decision.reason })
    return
  }

  const result = await startSharedPg()
  if (!result.ok) {
    // Docker not installed / daemon not running / image unavailable: skip, do not fail. Only reachable
    // where a skip is legitimate: startSharedPg throws in CI rather than returning !ok.
    console.warn(`[pg globalSetup] skipped: docker unavailable (${firstLine(result.reason)})`)
    provide("civfixPg", { kind: "unavailable", reason: result.reason })
    return
  }
  shared = result.pg
  provide("civfixPg", {
    kind: "ready",
    adminUri: shared.adminUri,
    templateDb: shared.templateDb,
  })
}

export async function teardown(): Promise<void> {
  const pg = shared
  shared = undefined
  await pg?.stop()
}

function firstLine(s: string): string {
  const i = s.indexOf("\n")
  return i === -1 ? s : s.slice(0, i)
}
