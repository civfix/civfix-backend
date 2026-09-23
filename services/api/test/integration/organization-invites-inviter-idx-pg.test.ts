import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"

const pg = await withPg()

describe.skipIf(!pg)("organization_invites inviter index (0182, integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("builds a partial index on invited_by over pending invites", async () => {
    const rows = await h.sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'organization_invites'
        AND indexname = 'organization_invites_inviter_pending_idx'
    `

    expect(rows).toHaveLength(1)
    expect(rows[0]!.indexdef).toMatch(/\(invited_by\)/)
    expect(rows[0]!.indexdef).toMatch(/WHERE \(status = 'pending'::text\)/)
  })
})
