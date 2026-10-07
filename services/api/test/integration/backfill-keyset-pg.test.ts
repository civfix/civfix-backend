/**
 * The reference-code backfill's keyset cursor against a real driver and database (Docker-gated; CI runs
 * it). A row that keeps failing stays unstamped, so the loop ends only if the cursor bound sits exactly on
 * that row; an anchor the driver cut to milliseconds sat below it and re-selected it forever.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { stampReferenceCodes, type ReferenceCodeRow } from "../../src/db/backfill-keyset.js"

const pg = await withPg()

describe.skipIf(!pg)("reference-code backfill keyset cursor (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("visits a failing sub-millisecond tail row once and terminates", async () => {
    const [user] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES ('Backfill Host', ${testHandle()}) RETURNING id
    `
    const ids: string[] = []
    for (const at of ["2026-01-01T00:00:00.100250Z", "2026-01-01T00:00:00.200750Z"]) {
      const id = await seedCleanup(h.sql, { organizerUserId: user!.id })
      await h.sql`
        UPDATE cleanups SET reference_code = NULL, created_at = ${at}::text::timestamptz
         WHERE id = ${id}
      `
      ids.push(id)
    }
    const [stamped, failing] = ids as [string, string]

    // A second visit to the failing row is the bug; stamping it then lets the old loop end.
    let failingVisits = 0
    const result = await stampReferenceCodes<ReferenceCodeRow>(h.sql, {
      table: "cleanups",
      batchSize: 1,
      label: "backfill-keyset-pg",
      extraColumn: null,
      allocate: (_tx, row) => {
        if (row.id !== failing) return Promise.resolve(`T-${row.id}`)
        failingVisits += 1
        return failingVisits === 1
          ? Promise.reject(new Error("allocator refused"))
          : Promise.resolve(`T-${row.id}`)
      },
    })

    expect(failingVisits).toBe(1)
    expect(result).toEqual({ stamped: 1, failed: 1 })
    const rows = await h.sql<{ id: string; reference_code: string | null }[]>`
      SELECT id, reference_code FROM cleanups WHERE id IN ${h.sql(ids)}
    `
    expect(new Map(rows.map((r) => [r.id, r.reference_code]))).toEqual(
      new Map([
        [stamped, `T-${stamped}`],
        [failing, null],
      ]),
    )
  })
})
