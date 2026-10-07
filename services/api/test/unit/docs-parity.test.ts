/**
 * Two doc facts have already drifted from the code once and cost real time:
 *
 *   1. The README's reviewer-OTP bypass table listed only two of the three variables the loader
 *      validates, so an operator following it would set `REVIEWER_OTP_BYPASS` in production and the box
 *      would refuse to boot on the missing `REVIEWER_OTP_BYPASS_ACK` (env.ts pushes that error).
 *   2. docs/operator-runbook.md carries an operational note for every migration from 0052 on and states
 *      how many files drizzle/ holds. A migration without a row is one whose backfill, out-of-band
 *      validation or image ordering nobody wrote down; a stale count is how "the full 59-file set"
 *      outlived the 60th file.
 *
 * Both are cheap to assert mechanically, so they are asserted here rather than re-reviewed by hand.
 * No DB, no network: readdir + readFileSync only.
 */

import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { REVIEWER_OTP_CODE_MIN_LENGTH } from "../../src/env.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const DRIZZLE_DIR = join(HERE, "..", "..", "drizzle")
const ENV_TS = join(HERE, "..", "..", "src", "env.ts")
const BACKEND_ROOT = join(HERE, "..", "..", "..", "..")
const README = join(BACKEND_ROOT, "README.md")
const DOCS_DIR = join(BACKEND_ROOT, "docs")

/** The first (and only) doc that carries the operator runbook, found by heading, not filename. */
function readRunbookDoc(): string {
  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"))
  const hits = files
    .map((f) => readFileSync(join(DOCS_DIR, f), "utf8"))
    .filter((text) => text.includes("# Operator runbook"))
  expect(hits, "exactly one docs/*.md should carry the operator runbook").toHaveLength(1)
  return hits[0]!
}

/** Migration filenames, sorted, exactly as the runner sees them (src/db/migrate.ts sorts lexically). */
function migrationFiles(): string[] {
  return readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
}

describe("README reviewer-OTP bypass table", () => {
  const readme = readFileSync(README, "utf8")

  it("documents every REVIEWER_OTP_* variable the env loader reads", () => {
    const envSource = readFileSync(ENV_TS, "utf8")
    const declared = [...envSource.matchAll(/source\.(REVIEWER_OTP_[A-Z_]+)/g)].map((m) => m[1]!)
    // Sanity: the loader really does read all three (a rename that drops one must fail loudly here
    // rather than making the README check vacuous).
    expect(new Set(declared)).toEqual(
      new Set(["REVIEWER_OTP_BYPASS", "REVIEWER_OTP_BYPASS_ACK", "REVIEWER_OTP_CODE"]),
    )
    for (const name of new Set(declared)) {
      expect(readme, `README.md must document ${name}`).toContain(name)
    }
  })

  it("states the code-length floor the loader actually enforces", () => {
    expect(readme).toContain(`at least ${REVIEWER_OTP_CODE_MIN_LENGTH} characters`)
  })
})

describe("operator runbook vs drizzle/", () => {
  const doc = readRunbookDoc()

  it("has a row for every migration this change set added (0052 and later)", () => {
    const manual = migrationFiles().filter((f) => Number(f.slice(0, 4)) >= 52)
    // Guard against the filter silently matching nothing if the naming convention changes.
    expect(manual.length).toBeGreaterThan(0)
    for (const file of manual) {
      expect(doc, `runbook must name ${file}`).toContain(file)
    }
  })

  it("names only migration files that exist", () => {
    const known = new Set(migrationFiles())
    const cited = new Set([...doc.matchAll(/`(\d{4}_[a-z0-9_]+\.sql)`/g)].map((m) => m[1]!))
    expect(cited.size).toBeGreaterThan(0)
    for (const file of cited) {
      expect(known, `runbook cites ${file}, which is not in drizzle/`).toContain(file)
    }
  })

  it("states the real number of migration files", () => {
    const stated = /holds \*\*(\d+) files\*\*/.exec(doc)
    expect(stated, "runbook should state how many files drizzle/ holds").not.toBeNull()
    expect(Number(stated![1])).toBe(migrationFiles().length)
  })
})
