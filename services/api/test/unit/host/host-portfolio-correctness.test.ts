import { describe, expect, it } from "vitest"
import { makeHostPortfolioService } from "../../../src/services/host/host-portfolio-service.js"
import {
  hostedRegistrationTotals,
  makeDrizzleHostPortfolioRepository,
} from "../../../src/services/host/host-portfolio-repository.drizzle.js"
import type { HostedEventRecord } from "../../../src/services/host/host-portfolio-repository.js"
import { makeFakeSql } from "../../helpers/fake-sql.js"
import type { Sql } from "../../../src/db/client.js"

const HOST = "11111111-1111-4111-8111-111111111111"
const SHOWN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const NOW = new Date("2026-09-12T12:00:00.000Z")

function record(id: string): HostedEventRecord {
  return {
    id,
    referenceCode: null,
    title: "Lincoln Park cleanup",
    startsAt: new Date("2026-09-29T16:00:00.000Z"),
    endsAt: null,
    timezone: null,
    status: "upcoming",
    visibility: "public",
    coverKey: null,
    capacity: null,
    eventRole: "organizer",
    orgRole: null,
    orgId: null,
    orgName: null,
    pageSlug: null,
    pageStatus: null,
  }
}

function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim()
}

describe("portfolio registration totals", () => {
  it("come from the whole hosted portfolio, not from the page being shown", async () => {
    const totalsAsked: (string | null)[] = []
    const service = makeHostPortfolioService({
      repo: {
        listHostedEvents: () => Promise.resolve({ items: [record(SHOWN)], nextCursor: "next" }),
        kpisFor: () => Promise.resolve({ eventsHosted: 3, upcomingEvents: 1 }),
      },
      counts: () =>
        Promise.resolve(
          new Map([[SHOWN, { registered: 5, checkedIn: 2, waitlisted: 0, hoursCredited: 0 }]]),
        ),
      totals: (args) => {
        totalsAsked.push(args.organizationId)
        return Promise.resolve({ totalRegistrations: 12, totalCheckedIn: 7 })
      },
      now: () => NOW,
    })

    const page = await service.listMyHostedEvents(HOST, { when: "upcoming", orgId: ORG, limit: 1 })

    expect(page.items.map((item) => item.registeredCount)).toEqual([5])
    expect(page.kpis).toEqual({
      eventsHosted: 3,
      upcomingEvents: 1,
      totalRegistrations: 12,
      totalCheckedIn: 7,
    })
    expect(totalsAsked).toEqual([ORG])
  })

  it("sum registered parties and checked-in seats over the hosted set in one statement", async () => {
    const fake = makeFakeSql([
      { match: /total_registrations/, rows: [{ total_registrations: 12, total_checked_in: 7 }] },
    ])

    const totals = await hostedRegistrationTotals(fake.sql as unknown as Sql, {
      userId: HOST,
      organizationId: ORG,
    })

    expect(totals).toEqual({ totalRegistrations: 12, totalCheckedIn: 7 })
    expect(fake.statements).toHaveLength(1)
    const text = flat(fake.statements[0]?.sql ?? "")
    expect(text).toContain("sum(r.party_size)")
    expect(text).toContain("r.status = 'registered'")
    expect(text).toContain("s.status = 'active' AND s.checked_in_at IS NOT NULL")
    expect(text).toContain("AND c.organization_id = ?")
    expect(fake.statements[0]?.values).toContain(ORG)
  })
})

describe("hosted event rows", () => {
  it("carry the event page's status and ignore roles in a deleted organization", async () => {
    const fake = makeFakeSql([
      {
        match: /WITH hosted AS/,
        rows: [
          {
            id: SHOWN,
            reference_code: null,
            title: "Lincoln Park cleanup",
            scheduled_at: new Date("2026-09-29T16:00:00.000Z"),
            ends_at: null,
            timezone: null,
            status: "upcoming",
            visibility: "public",
            cover_key: null,
            capacity: null,
            event_role: "organizer",
            org_role: null,
            org_id: null,
            org_name: null,
            page_slug: "park-day",
            page_status: "published",
          },
        ],
      },
    ])

    const page = await makeDrizzleHostPortfolioRepository(
      fake.sql as unknown as Sql,
    ).listHostedEvents({ userId: HOST, when: "all", organizationId: null, cursor: null, limit: 20 })

    expect(page.items[0]?.pageStatus).toBe("published")
    const text = flat(fake.statements[0]?.sql ?? "")
    expect(text).toContain("LEFT JOIN cleanup_pages p ON p.cleanup_id = c.id")
    expect(text).toMatch(
      /SELECT om\.role FROM organization_members om JOIN organizations oo ON oo\.id = om\.organization_id AND oo\.deleted_at IS NULL/,
    )
  })

  it("reach the DTO with their page status", async () => {
    const service = makeHostPortfolioService({
      repo: {
        listHostedEvents: () =>
          Promise.resolve({
            items: [{ ...record(SHOWN), pageSlug: "park-day", pageStatus: "draft" as const }],
            nextCursor: null,
          }),
        kpisFor: () => Promise.resolve({ eventsHosted: 1, upcomingEvents: 1 }),
      },
      counts: () => Promise.resolve(new Map()),
      totals: () => Promise.resolve({ totalRegistrations: 0, totalCheckedIn: 0 }),
      now: () => NOW,
    })

    const page = await service.listMyHostedEvents(HOST, { when: "all" })

    expect(page.items[0]?.pageStatus).toBe("draft")
  })
})
