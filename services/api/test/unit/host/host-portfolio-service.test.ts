import { describe, expect, it } from "vitest"
import { makeHostPortfolioService } from "../../../src/services/host/host-portfolio-service.js"
import type {
  HostedEventRecord,
  HostPortfolioRepository,
} from "../../../src/services/host/host-portfolio-repository.drizzle.js"
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

const ORG_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const ORG_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const A_UPCOMING = "a1111111-1111-4111-8111-111111111111"
const A_PAST = "a2222222-2222-4222-8222-222222222222"
const B_UPCOMING = "b1111111-1111-4111-8111-111111111111"
const PERSONAL = "e1111111-1111-4111-8111-111111111111"

const PORTFOLIO: HostedEventRecord[] = [
  record({
    id: A_UPCOMING,
    orgId: ORG_A,
    orgName: "Adopt-a-Block LA",
    status: "upcoming",
    startsAt: new Date("2026-09-26T16:00:00.000Z"),
  }),
  record({ id: A_PAST, orgId: ORG_A, orgName: "Adopt-a-Block LA", status: "done" }),
  record({
    id: B_UPCOMING,
    orgId: ORG_B,
    orgName: "Hollenbeck Friends",
    status: "upcoming",
    startsAt: new Date("2026-09-20T16:00:00.000Z"),
  }),
  record({
    id: PERSONAL,
    status: "upcoming",
    startsAt: new Date("2026-09-13T16:00:00.000Z"),
  }),
]

function scopedRepo(records: readonly HostedEventRecord[]): HostPortfolioRepository {
  const inScope = (organizationId: string | null) =>
    organizationId === null ? records : records.filter((row) => row.orgId === organizationId)
  return {
    listHostedEvents: (args) =>
      Promise.resolve({ items: [...inScope(args.organizationId)], nextCursor: null }),
    kpisFor: (args) => {
      const rows = inScope(args.organizationId)
      return Promise.resolve({
        eventsHosted: rows.length,
        upcomingEvents: rows.filter((row) => row.startsAt >= args.now && row.status !== "cancelled")
          .length,
      })
    },
  }
}

function portfolioService(counts: Map<string, HostedEventCounts>) {
  return makeHostPortfolioService({
    repo: scopedRepo(PORTFOLIO),
    counts: (ids) =>
      Promise.resolve(
        new Map(
          ids.flatMap((id) => {
            const row = counts.get(id)
            return row === undefined ? [] : [[id, row] as const]
          }),
        ),
      ),
    now: () => NOW,
  })
}

const PORTFOLIO_COUNTS = new Map<string, HostedEventCounts>([
  [A_UPCOMING, { registered: 23, checkedIn: 0, waitlisted: 0, hoursCredited: 0 }],
  [A_PAST, { registered: 25, checkedIn: 16, waitlisted: 0, hoursCredited: 63.5 }],
  [B_UPCOMING, { registered: 9, checkedIn: 2, waitlisted: 0, hoursCredited: 0 }],
  [PERSONAL, { registered: 11, checkedIn: 1, waitlisted: 0, hoursCredited: 0 }],
])

describe("F4: the portfolio KPIs obey the same org scope as the items", () => {
  it("counts the whole personal portfolio when no org is asked for", async () => {
    const page = await portfolioService(PORTFOLIO_COUNTS).listMyHostedEvents(HOST, { when: "all" })

    expect(page.items.map((row) => row.id)).toEqual([A_UPCOMING, A_PAST, B_UPCOMING, PERSONAL])
    expect(page.kpis).toEqual({
      eventsHosted: 4,
      upcomingEvents: 3,
      totalRegistrations: 68,
      totalCheckedIn: 19,
    })
  })

  it("reports all-zero KPIs for an org the host has never hosted for", async () => {
    const page = await portfolioService(PORTFOLIO_COUNTS).listMyHostedEvents(HOST, {
      when: "upcoming",
      orgId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    })

    expect(page.items).toEqual([])
    expect(page.kpis).toEqual({
      eventsHosted: 0,
      upcomingEvents: 0,
      totalRegistrations: 0,
      totalCheckedIn: 0,
    })
  })

  it("counts only the asked-for org's events when that org has some", async () => {
    const page = await portfolioService(PORTFOLIO_COUNTS).listMyHostedEvents(HOST, {
      when: "all",
      orgId: ORG_A,
    })

    expect(page.items.map((row) => row.id)).toEqual([A_UPCOMING, A_PAST])
    expect(page.kpis).toEqual({
      eventsHosted: 2,
      upcomingEvents: 1,
      totalRegistrations: 48,
      totalCheckedIn: 16,
    })
  })

  it("passes the org filter to the KPI query, not just to the items query", async () => {
    const seen: (string | null)[] = []
    const service = makeHostPortfolioService({
      repo: {
        listHostedEvents: () => Promise.resolve({ items: [], nextCursor: null }),
        kpisFor: (args) => {
          seen.push(args.organizationId)
          return Promise.resolve({ eventsHosted: 0, upcomingEvents: 0 })
        },
      },
      counts: () => Promise.resolve(new Map()),
      now: () => NOW,
    })

    await service.listMyHostedEvents(HOST, { when: "upcoming", orgId: ORG_B })
    await service.listMyHostedEvents(HOST, { when: "upcoming" })

    expect(seen).toEqual([ORG_B, null])
  })
})
