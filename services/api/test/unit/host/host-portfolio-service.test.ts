import { describe, expect, it } from "vitest"
import { makeHostPortfolioService } from "../../../src/services/host/host-portfolio-service.js"
import type { HostedEventRecord } from "../../../src/services/host/host-portfolio-repository.drizzle.js"
import type { HostedEventCounts } from "../../../src/services/host/portfolio-counts.js"
import { makeFakeSql } from "../../helpers/fake-sql.js"
import { hostedEventCounts } from "../../../src/services/host/portfolio-counts.js"
import type { Sql } from "../../../src/db/client.js"

const HOST = "11111111-1111-4111-8111-111111111111"
const CREDITED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const UNCREDITED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const NOW = new Date("2026-09-12T12:00:00.000Z")

function record(over: Partial<HostedEventRecord> & { id: string }): HostedEventRecord {
  return {
    referenceCode: null,
    title: "Lincoln Park cleanup",
    startsAt: new Date("2026-08-29T16:00:00.000Z"),
    endsAt: null,
    timezone: null,
    status: "done",
    visibility: "public",
    coverKey: null,
    capacity: null,
    eventRole: "organizer",
    orgRole: null,
    orgId: null,
    orgName: null,
    pageSlug: null,
    ...over,
  }
}

function build(counts: Map<string, HostedEventCounts>) {
  return makeHostPortfolioService({
    repo: {
      listHostedEvents: () =>
        Promise.resolve({
          items: [record({ id: CREDITED }), record({ id: UNCREDITED })],
          nextCursor: null,
        }),
      kpisFor: () => Promise.resolve({ eventsHosted: 2, upcomingEvents: 0 }),
    },
    counts: () => Promise.resolve(counts),
    now: () => NOW,
  })
}

describe("#110: hoursCredited on every hosted event row", () => {
  it("carries the credited hours the counts loader found for that event", async () => {
    const service = build(
      new Map([[CREDITED, { registered: 25, checkedIn: 16, waitlisted: 0, hoursCredited: 63.5 }]]),
    )
    const page = await service.listMyHostedEvents(HOST, { when: "past" })

    expect(page.items.map((row) => [row.id, row.hoursCredited])).toEqual([
      [CREDITED, 63.5],
      [UNCREDITED, 0],
    ])
  })

  it("emits the field on every row even when nothing has been credited anywhere", async () => {
    const page = await build(new Map()).listMyHostedEvents(HOST, { when: "past" })
    expect(page.items).toHaveLength(2)
    for (const row of page.items) expect(row.hoursCredited).toBe(0)
  })
})

describe("#110: the hosted-events page costs one hours query, not one per row", () => {
  it("reads the ledger once for the whole bounded page", async () => {
    const fake = makeFakeSql()
    await hostedEventCounts(fake.sql as unknown as Sql, [CREDITED, UNCREDITED])

    const hoursStatements = fake.statements.filter((stmt) => stmt.sql.includes("volunteer_hours"))
    expect(hoursStatements).toHaveLength(1)
    const text = (hoursStatements[0]?.sql ?? "").replace(/\s+/g, " ")
    expect(text).toContain("vh.cleanup_id = ANY(")
    expect(text).toContain("vh.source = 'event'")
    expect(text).toContain("vh.voided_at IS NULL")
    expect(text).toContain("GROUP BY vh.cleanup_id")
  })

  it("asks for nothing when the page is empty", async () => {
    const fake = makeFakeSql()
    const counts = await hostedEventCounts(fake.sql as unknown as Sql, [])
    expect(counts.size).toBe(0)
    expect(fake.statements).toEqual([])
  })
})
