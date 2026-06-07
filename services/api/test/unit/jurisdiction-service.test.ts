import { describe, it, expect } from "vitest"
import { FakeJobs, FakeGeocoder } from "@civfix/shared/fakes"
import type { Sql } from "../../src/db/client.js"
import {
  needsDiscovery,
  isRoutable,
  makeJurisdictionService,
  JURISDICTION_DISCOVERY_JOB,
  type JurisdictionHealthRow,
} from "../../src/services/jurisdiction-service.js"

/**
 * Unit tests for the jurisdiction service. The pure `needsDiscovery` decision is tested directly; the
 * service's resolve-and-enqueue behavior is tested against a hand-stubbed `sql` tag (no DB, no Docker)
 * that answers the two queries the service issues: the canonical resolver (sql.unsafe) and the scalar
 * health read (tagged template).
 */

const NOW = new Date("2026-05-31T00:00:00.000Z")

/** A jurisdiction the resolver returns. Shape matches ResolvedJurisdiction (geoid/name/layer). */
interface ResolvedRow {
  geoid: string
  name: string
  layer: "place" | "county" | "state"
}

/** Row shape returned by the health query (snake_case columns, as the DB would). */
interface HealthDbRow {
  geoid: string
  contact_emails: string[] | null
  contact_updated_at: Date | null
  population: number | null
  /** Phase 2: whether a usable jurisdiction_contacts row exists (drives routable without legacy emails). */
  has_routing_contact?: boolean
}

/**
 * Build a fake postgres-js tag. It is callable as a tagged template (returns the queued health rows)
 * and exposes `.unsafe` (returns the queued resolver rows). Enough to drive the service offline.
 */
function makeFakeSql(opts: { resolveRows: ResolvedRow[]; healthRows?: HealthDbRow[] }): Sql {
  // Tagged-template invocation answers the scalar health read.
  const fn = (_strings: TemplateStringsArray, ..._values: unknown[]) =>
    Promise.resolve(opts.healthRows ?? [])
  // `.unsafe(text, params)` answers the canonical resolver query (resolveJurisdiction). The real Sql
  // type has a heavily-overloaded `unsafe`; we only need this one call shape, so we attach it on an
  // `any` view and cast the whole stub to Sql (test-only seam).
  ;(fn as unknown as { unsafe: unknown }).unsafe = (_text: string, _params?: unknown[]) =>
    Promise.resolve(opts.resolveRows)
  return fn as unknown as Sql
}

describe("needsDiscovery (pure)", () => {
  it("returns true when contact_emails is null", () => {
    const row: JurisdictionHealthRow = {
      geoid: "0644000",
      contactEmails: null,
      contactUpdatedAt: NOW,
    }
    expect(needsDiscovery(row, NOW)).toBe(true)
  })

  it("returns true when contact_emails is empty or all-blank", () => {
    expect(
      needsDiscovery({ geoid: "x", contactEmails: [], contactUpdatedAt: NOW }, NOW),
    ).toBe(true)
    expect(
      needsDiscovery({ geoid: "x", contactEmails: ["", "   "], contactUpdatedAt: NOW }, NOW),
    ).toBe(true)
  })

  it("returns true when contact_updated_at is missing", () => {
    const row: JurisdictionHealthRow = {
      geoid: "x",
      contactEmails: ["311@example.gov"],
      contactUpdatedAt: null,
    }
    expect(needsDiscovery(row, NOW)).toBe(true)
  })

  it("returns true when contact metadata is older than 18 months", () => {
    // 19 months before NOW -> stale.
    const stale = new Date(NOW)
    stale.setMonth(stale.getMonth() - 19)
    const row: JurisdictionHealthRow = {
      geoid: "x",
      contactEmails: ["311@example.gov"],
      contactUpdatedAt: stale,
    }
    expect(needsDiscovery(row, NOW)).toBe(true)
  })

  it("returns false for a fresh jurisdiction with a contact", () => {
    // 17 months before NOW -> within the window.
    const fresh = new Date(NOW)
    fresh.setMonth(fresh.getMonth() - 17)
    const row: JurisdictionHealthRow = {
      geoid: "x",
      contactEmails: ["311@example.gov"],
      contactUpdatedAt: fresh,
    }
    expect(needsDiscovery(row, NOW)).toBe(false)
  })
})

/**
 * Phase 2 routing-resolution precedence: needsDiscovery now consults the per-category routing model
 * (category-specific / default jurisdiction_contacts -> legacy contact_emails[]) via the
 * `hasRoutingContact` flag. These cases prove the precedence + backward compatibility.
 */
describe("needsDiscovery (per-category routing precedence)", () => {
  it("is routable when a jurisdiction_contacts row exists even though legacy contact_emails is empty", () => {
    // No legacy emails, but a per-category/default contact row is on file -> NOT needs discovery.
    const row: JurisdictionHealthRow = {
      geoid: "x",
      contactEmails: null,
      contactUpdatedAt: NOW,
      hasRoutingContact: true,
    }
    expect(needsDiscovery(row, NOW)).toBe(false)
  })

  it("a just-saved jurisdiction_contacts row with no timestamp does NOT re-flag (the row is the signal)", () => {
    const row: JurisdictionHealthRow = {
      geoid: "x",
      contactEmails: null,
      contactUpdatedAt: null,
      hasRoutingContact: true,
    }
    expect(needsDiscovery(row, NOW)).toBe(false)
  })

  it("a jurisdiction_contacts row still re-flags once its contact metadata goes stale", () => {
    const stale = new Date(NOW)
    stale.setMonth(stale.getMonth() - 19)
    const row: JurisdictionHealthRow = {
      geoid: "x",
      contactEmails: null,
      contactUpdatedAt: stale,
      hasRoutingContact: true,
    }
    expect(needsDiscovery(row, NOW)).toBe(true)
  })

  it("BACKWARD COMPATIBLE: with hasRoutingContact absent/false it reduces to the legacy check", () => {
    // No routing row and no legacy emails -> needs discovery (unchanged Phase 1 behavior).
    expect(
      needsDiscovery({ geoid: "x", contactEmails: null, contactUpdatedAt: NOW }, NOW),
    ).toBe(true)
    expect(
      needsDiscovery(
        { geoid: "x", contactEmails: null, contactUpdatedAt: NOW, hasRoutingContact: false },
        NOW,
      ),
    ).toBe(true)
    // Legacy fresh emails, no routing row -> routable (unchanged).
    const fresh = new Date(NOW)
    fresh.setMonth(fresh.getMonth() - 1)
    expect(
      needsDiscovery({ geoid: "x", contactEmails: ["311@x.gov"], contactUpdatedAt: fresh }, NOW),
    ).toBe(false)
  })
})

describe("makeJurisdictionService.resolveForPoint", () => {
  const resolved: ResolvedRow = { geoid: "0644000", name: "Los Angeles", layer: "place" }

  it("returns a JurisdictionDTO with a geocoder-derived label", async () => {
    const geocoder = new FakeGeocoder()
    geocoder.setLabel(34.1, -118.35, "Los Angeles, CA")
    const jobs = new FakeJobs()
    const sql = makeFakeSql({
      resolveRows: [resolved],
      healthRows: [
        {
          geoid: "0644000",
          contact_emails: ["311@example.lacity.gov"],
          contact_updated_at: NOW,
          population: 3_900_000,
        },
      ],
    })
    const service = makeJurisdictionService({ sql, geocoder, jobs, now: () => NOW })

    const dto = await service.resolveForPoint(34.1, -118.35)
    expect(dto).not.toBeNull()
    expect(dto?.geoid).toBe("0644000")
    expect(dto?.layer).toBe("place")
    expect(dto?.cityStateLabel).toBe("Los Angeles, CA")
    // A legacy contact email is on file -> the jurisdiction is routable.
    expect(dto?.routable).toBe(true)
  })

  it("returns null when the point resolves to no jurisdiction", async () => {
    const sql = makeFakeSql({ resolveRows: [] })
    const service = makeJurisdictionService({
      sql,
      geocoder: new FakeGeocoder(),
      jobs: new FakeJobs(),
      now: () => NOW,
    })
    const dto = await service.resolveForPoint(40, -100)
    expect(dto).toBeNull()
  })

  it("enqueues EXACTLY ONE discovery job (singletonKey=geoid) for a needs-discovery jurisdiction", async () => {
    const jobs = new FakeJobs()
    const sql = makeFakeSql({
      resolveRows: [resolved],
      healthRows: [
        // No contact emails -> needsDiscovery true.
        { geoid: "0644000", contact_emails: null, contact_updated_at: null, population: 3_900_000 },
      ],
    })
    const service = makeJurisdictionService({
      sql,
      geocoder: new FakeGeocoder(),
      jobs,
      now: () => NOW,
    })

    await service.resolveForPoint(34.1, -118.35)

    const enqueued = jobs.jobsFor(JURISDICTION_DISCOVERY_JOB)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]?.data).toMatchObject({ geoid: "0644000" })
    expect(enqueued[0]?.opts?.singletonKey).toBe("0644000")
  })

  it("does NOT enqueue for a healthy (fresh + contactful) jurisdiction", async () => {
    const jobs = new FakeJobs()
    const sql = makeFakeSql({
      resolveRows: [resolved],
      healthRows: [
        {
          geoid: "0644000",
          contact_emails: ["311@example.lacity.gov"],
          contact_updated_at: NOW,
          population: 3_900_000,
        },
      ],
    })
    const service = makeJurisdictionService({
      sql,
      geocoder: new FakeGeocoder(),
      jobs,
      now: () => NOW,
    })

    await service.resolveForPoint(34.1, -118.35)
    expect(jobs.jobsFor(JURISDICTION_DISCOVERY_JOB)).toHaveLength(0)
  })

  it("sets routable=true via a jurisdiction_contacts row even without legacy emails", async () => {
    const sql = makeFakeSql({
      resolveRows: [resolved],
      healthRows: [
        {
          geoid: "0644000",
          contact_emails: null,
          contact_updated_at: NOW,
          population: 100,
          has_routing_contact: true,
        },
      ],
    })
    const service = makeJurisdictionService({
      sql,
      geocoder: new FakeGeocoder(),
      jobs: new FakeJobs(),
      now: () => NOW,
    })
    const dto = await service.resolveForPoint(34.1, -118.35)
    expect(dto?.routable).toBe(true)
  })

  it("sets routable=false when the jurisdiction has no contact at all", async () => {
    const sql = makeFakeSql({
      resolveRows: [resolved],
      healthRows: [
        { geoid: "0644000", contact_emails: null, contact_updated_at: null, population: 100 },
      ],
    })
    const service = makeJurisdictionService({
      sql,
      geocoder: new FakeGeocoder(),
      jobs: new FakeJobs(),
      now: () => NOW,
    })
    const dto = await service.resolveForPoint(34.1, -118.35)
    expect(dto?.routable).toBe(false)
  })
})

describe("isRoutable (pure)", () => {
  it("true with a usable legacy contact email", () => {
    expect(isRoutable({ hasRoutingContact: false, contactEmails: ["311@x.gov"] })).toBe(true)
  })
  it("true with a jurisdiction_contacts routing row", () => {
    expect(isRoutable({ hasRoutingContact: true, contactEmails: null })).toBe(true)
  })
  it("false with neither (empty/blank legacy + no routing row)", () => {
    expect(isRoutable({ hasRoutingContact: false, contactEmails: [] })).toBe(false)
    expect(isRoutable({ hasRoutingContact: false, contactEmails: ["", "  "] })).toBe(false)
  })
})
