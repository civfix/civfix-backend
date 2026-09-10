import { describe, expect, it } from "vitest"
import { findDrizzleClientUses } from "../../../../scripts/check-dynamic-sql.mjs"

describe("check:sql — raw SQL on drizzle's own client", () => {
  it("flags the aliased tag the orphan sweep used to run its Date-bound predicate on", () => {
    const code = ["const tag = db.$client", "const rows = await tag`SELECT 1`"].join("\n")
    expect(findDrizzleClientUses(code)).toEqual([".$client"])
  })

  it("flags a direct tagged template and a client handed to a helper", () => {
    expect(findDrizzleClientUses("await db.$client`DELETE FROM media_assets`")).toHaveLength(1)
    expect(findDrizzleClientUses("resolveAvatarMediaOrThrow(this.db.$client, uploadId)")).toHaveLength(1)
  })

  it("leaves the fully-serializing raw tag alone", () => {
    const code = ["const rows = await sql`SELECT 1`", "await dbHandle.sql`SELECT 2`"].join("\n")
    expect(findDrizzleClientUses(code)).toEqual([])
  })
})
