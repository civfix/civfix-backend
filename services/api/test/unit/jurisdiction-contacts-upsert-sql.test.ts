import { describe, expect, it } from "vitest"
import type { Queryable } from "../../src/db/client.js"
import { upsertJurisdictionContacts } from "../../src/services/admin/jurisdiction-contacts-repository.drizzle.js"
import { makeSqlRecorder, type SqlRecorder } from "../helpers/sql-recorder.js"

const GEOID = "0644000"
const CATEGORY_DELETE = /^DELETE FROM jurisdiction_contacts/
const CATEGORY_UPSERT =
  /^INSERT INTO jurisdiction_contacts \(geoid, category, email, updated_at, bounced_at\)/

async function save(
  contacts: Parameters<typeof upsertJurisdictionContacts>[2],
): Promise<SqlRecorder> {
  const rec = makeSqlRecorder()
  await upsertJurisdictionContacts(rec.sql as unknown as Queryable, GEOID, contacts, [], null)
  return rec
}

describe("saving per-category jurisdiction contacts", () => {
  it("clears and sets every category with one DELETE and one unnest upsert", async () => {
    const rec = await save({
      trash: " trash@example.gov ",
      graffiti: null,
      hazard: "   ",
      water: "water@example.gov",
      other: "other@example.gov",
    })

    expect(rec.queries).toHaveLength(2)
    const [clear, upsert] = rec.queries
    expect(clear!.text).toMatch(CATEGORY_DELETE)
    expect(clear!.text).toContain("category = ANY($2::text[])")
    expect(clear!.params).toEqual([GEOID, ["graffiti", "hazard"]])

    expect(upsert!.text).toMatch(CATEGORY_UPSERT)
    expect(upsert!.text).toContain("FROM unnest($2::text[], $3::text[]) AS u(category, email)")
    expect(upsert!.text).toContain("ON CONFLICT (geoid, category) WHERE category IS NOT NULL")
    expect(upsert!.text).toContain("bounced_at = NULL")
    expect(upsert!.params).toEqual([
      GEOID,
      ["trash", "water", "other"],
      ["trash@example.gov", "water@example.gov", "other@example.gov"],
    ])
  })

  it("sends no DELETE when nothing is cleared", async () => {
    const rec = await save({ trash: "trash@example.gov", recycling: "recycling@example.gov" })

    expect(rec.queries).toHaveLength(1)
    expect(rec.queries[0]!.text).toMatch(CATEGORY_UPSERT)
  })

  it("sends no upsert when every category is cleared", async () => {
    const rec = await save({ trash: null, recycling: "" })

    expect(rec.queries).toHaveLength(1)
    expect(rec.queries[0]!.text).toMatch(CATEGORY_DELETE)
    expect(rec.queries[0]!.params).toEqual([GEOID, ["trash", "recycling"]])
  })

  it("sends nothing for an empty contact map", async () => {
    const rec = await save({})

    expect(rec.queries).toHaveLength(0)
  })
})
