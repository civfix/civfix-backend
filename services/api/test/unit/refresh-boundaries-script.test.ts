/**
 * scripts/refresh-boundaries.ts — the nationwide boundary refresh (TIGER + PAD-US). The script runs
 * `main()` on import, so it cannot be exercised in-process; these are structural assertions over its
 * SOURCE, which is how the two failure modes below present themselves (both are ordering/configuration mistakes
 * that no runtime assertion in this repo can reach without a live Census download).
 *
 * F141: it is the only DB entry point that used the REQUEST-path timeouts. makeDb defaults to
 * statementTimeoutMs 15s / idleInTxTimeoutMs 30s and pushes them as startup parameters; every other CLI
 * (src/db/cli.ts runDbCli, scripts/revoke-certificate.ts) deliberately disables both because these are
 * exactly the statements those timeouts exist to kill — a 1000-row correlated ST_Contains UPDATE, a
 * full-table UPDATE over reports, and per-feature inserts of continent-scale multipolygons.
 *
 * F142: pruneNonAuthoritative COMMITS destructive deletes (jurisdictions + every FK pointer into them).
 * Running it before the fallible download/convert/ingest means any failure after it — a Census layer
 * that 404s, a missing ogr2ogr source, a statement timeout — strictly REDUCES coverage with no re-seed
 * path. In full-refresh mode the prune must therefore happen only AFTER the ingest loop succeeded;
 * --backfill-only keeps it up front, where nothing fallible precedes it.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SCRIPT = readFileSync(
  fileURLToPath(new URL("../../scripts/refresh-boundaries.ts", import.meta.url)),
  "utf8",
)

describe("refresh-boundaries: connection posture (F141)", () => {
  it("opens its connection with the long-running-CLI timeouts, not the request-path defaults", () => {
    const call = SCRIPT.match(/makeDb\(databaseUrl[^)]*\)/)
    expect(call).not.toBeNull()
    expect(call![0]).toContain("statementTimeoutMs: 0")
    expect(call![0]).toContain("idleInTxTimeoutMs: 0")
  })

  it("opens exactly one pooled connection (a single-writer maintenance script)", () => {
    const call = SCRIPT.match(/makeDb\(databaseUrl[^)]*\)/)
    expect(call![0]).toContain("max: 1")
  })
})

describe("refresh-boundaries: the destructive prune runs LAST (F142)", () => {
  const fullModePrune = SCRIPT.lastIndexOf("await prune(handle.sql)")
  const backfillOnlyPrune = SCRIPT.indexOf("await prune(handle.sql)")

  it("prunes in full-refresh mode only after the download/convert/ingest loop has succeeded", () => {
    expect(backfillOnlyPrune).toBeGreaterThan(0)
    expect(fullModePrune).toBeGreaterThan(backfillOnlyPrune)

    const convertedGuard = SCRIPT.indexOf("no census layers converted")
    const ingestLoop = SCRIPT.indexOf("ingestGeoJsonSeqFile(handle.sql")
    expect(convertedGuard).toBeGreaterThan(0)
    expect(ingestLoop).toBeGreaterThan(convertedGuard)
    expect(fullModePrune).toBeGreaterThan(ingestLoop)
  })

  it("prunes before the backfill, so the backfill never re-resolves reports onto pruned rows", () => {
    const backfill = SCRIPT.indexOf("backfillReports(handle.sql)")
    expect(backfill).toBeGreaterThan(0)
    expect(fullModePrune).toBeLessThan(backfill)
  })

  it("keeps the --backfill-only prune inside its own branch, where nothing fallible precedes it", () => {
    const branch = SCRIPT.indexOf("if (backfillOnly) {")
    expect(branch).toBeGreaterThan(0)
    expect(backfillOnlyPrune).toBeGreaterThan(branch)
    expect(SCRIPT.slice(branch, backfillOnlyPrune)).not.toContain("fetchSource(")
  })
})
