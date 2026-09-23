import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { makeDrizzleJurisdictionContactsRepository } from "../../src/services/admin/jurisdiction-contacts-repository.drizzle.js"
import { makeDrizzleDiscoveryRepository } from "../../src/services/admin/discovery-repository.drizzle.js"
import type { ListDirectoryArgs } from "../../src/services/admin/jurisdiction-contacts-repository.js"
import type { Sql } from "../../src/db/client.js"

const DEFAULT_VIEW: ListDirectoryArgs = {
  q: null,
  filter: "all",
  layer: null,
  sort: "population",
  cursor: null,
  limit: 25,
}

const FACET_QUERY = /::text AS routed,/

describe("directory facet cache", () => {
  it("is dropped when a discovery draft saves contacts, so the routed/unrouted chips move at once", async () => {
    const fake = makeFakeSql([
      { match: /SELECT geoid FROM jurisdiction_discovery_tasks/, rows: [{ geoid: "0644000" }] },
      { match: /INSERT INTO audit_log/, rows: [{ id: "audit-1" }] },
      { match: FACET_QUERY, rows: [{ total: "10", routed: "4", unrouted: "6" }] },
    ])
    const sql = fake.sql as unknown as Sql
    const directory = makeDrizzleJurisdictionContactsRepository(sql)
    const discovery = makeDrizzleDiscoveryRepository(sql)
    const facetQueries = () => fake.statements.filter((s) => FACET_QUERY.test(s.sql)).length

    await directory.listDirectory(DEFAULT_VIEW)
    const afterFirst = facetQueries()
    await directory.listDirectory(DEFAULT_VIEW)
    expect(facetQueries()).toBe(afterFirst)

    await discovery.saveDraft("11111111-1111-1111-1111-111111111111", {
      contacts: { trash: "clerk@lacity.gov" },
      defaultEmails: [],
      formUrl: null,
      actorId: null,
    })
    await directory.listDirectory(DEFAULT_VIEW)
    expect(facetQueries()).toBe(afterFirst + 1)
  })
})
