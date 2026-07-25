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
import {
  CachedJurisdictionLookup,
  FakeJurisdictionLookup,
  type JurisdictionLookup,
} from "../../src/adapters/jurisdiction-lookup.census.js"

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

/** One recorded tagged-template `sql\`...\`` invocation: the static string fragments + interpolated values. */
interface TaggedCall {
  strings: readonly string[]
  values: unknown[]
}

/**
 * Build a fake postgres-js tag. It is callable as a tagged template (returns the queued health rows)
 * and exposes `.unsafe` (returns the queued resolver rows). Enough to drive the service offline.
 *
 * When `taggedCalls` is supplied, every tagged-template invocation (the health read AND the lazy
 * API-sourced upsert) is pushed onto it, so a test can assert the upsert actually ran and inspect the
 * values it interpolated.
 */
function makeFakeSql(opts: {
  resolveRows: ResolvedRow[]
  healthRows?: HealthDbRow[]
  taggedCalls?: TaggedCall[]
}): Sql {
  // Tagged-template invocation answers the scalar health read (and records the call, incl. the upsert).
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    opts.taggedCalls?.push({ strings: [...strings], values })
    return Promise.resolve(opts.healthRows ?? [])
  }
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

/**
 * Write-time Census fallback: on a LOCAL MISS (resolveRows: []), when the optional `jurisdictionLookup`
 * dep is present the service consults the lookup, lazily upserts the hit, and maps the report. Absence of
 * the dep is the backward-compatible local-only path (returns null).
 */
describe("resolveForPoint write-time Census fallback", () => {
  it("local miss + lookup HIT -> upserts the API row and returns its DTO (routable:false)", async () => {
    const taggedCalls: TaggedCall[] = []
    const sql = makeFakeSql({ resolveRows: [], taggedCalls })
    const lookup = new FakeJurisdictionLookup({
      geoid: "0644000",
      name: "Los Angeles",
      layer: "place",
    })
    const service = makeJurisdictionService({
      sql,
      geocoder: new FakeGeocoder(),
      jobs: new FakeJobs(),
      jurisdictionLookup: lookup,
      now: () => NOW,
    })

    const dto = await service.resolveForPoint(34.05, -118.25)

    expect(dto).not.toBeNull()
    expect(dto?.geoid).toBe("0644000")
    expect(dto?.layer).toBe("place")
    // cityStateLabel derived via uspsFromGeoid (FIPS prefix "06" -> "CA").
    expect(dto?.cityStateLabel).toBe("Los Angeles, CA")
    // A brand-new contact-less row is never routable yet.
    expect(dto?.routable).toBe(false)

    // The lazy insert ran: exactly one tagged-template call, and it carries the geoid/name/layer/priority
    // the lookup returned. (The health read is skipped on this path.)
    expect(taggedCalls).toHaveLength(1)
    const upsert = taggedCalls[0]!
    expect(upsert.strings.join("")).toContain("INSERT INTO jurisdictions")
    expect(upsert.strings.join("")).toContain("ON CONFLICT (geoid) DO NOTHING")
    // SELECT ${geoid}, ${name}, ${layer}, ${priority} (priority 2 is the 'place' rank) + the geoid again
    // in the NOT EXISTS guard.
    expect(upsert.values).toEqual(["0644000", "Los Angeles", "place", 2, "0644000"])
  })

  /**
   * A15 follow-up: `nextval('jurisdiction_code_seq')` must NOT sit in a VALUES list, because a VALUES list
   * is evaluated before the conflict is detected — every repeat call on this (anon-ok) path conflicts, so
   * the sequence was burned once per request forever. The guard has to be inside the statement; asserting
   * the SQL shape is the only offline way to pin it (the real-DB proof is in map-pg.test.ts).
   */
  it("draws the JURCODE inside a NOT EXISTS guard, never from a VALUES list", async () => {
    const taggedCalls: TaggedCall[] = []
    const sql = makeFakeSql({ resolveRows: [], taggedCalls })
    const service = makeJurisdictionService({
      sql,
      geocoder: new FakeGeocoder(),
      jobs: new FakeJobs(),
      jurisdictionLookup: new FakeJurisdictionLookup({
        geoid: "0644000",
        name: "Los Angeles",
        layer: "place",
      }),
      now: () => NOW,
    })

    await service.resolveForPoint(34.05, -118.25)

    const text = taggedCalls[0]!.strings.join("")
    expect(text).toContain("nextval('jurisdiction_code_seq')")
    expect(text).toContain("WHERE NOT EXISTS (SELECT 1 FROM jurisdictions WHERE geoid =")
    expect(text).not.toContain("VALUES (")
  })

  /**
   * The service itself does no memoization (a NULL-geom row can never become a local hit, so every repeat
   * call re-enters this path); the CALLER wraps the lookup. Pins the anon map wiring's effect: one
   * outbound lookup and one write for N resolves of the same point.
   */
  it("with a CachedJurisdictionLookup, a repeat resolve of the same point re-fires nothing", async () => {
    const taggedCalls: TaggedCall[] = []
    const sql = makeFakeSql({ resolveRows: [], taggedCalls })
    let lookupCalls = 0
    const inner: JurisdictionLookup = {
      lookup: (_lat, _lng) => {
        lookupCalls += 1
        return Promise.resolve({ geoid: "0644000", name: "Los Angeles", layer: "place" as const })
      },
    }
    const service = makeJurisdictionService({
      sql,
      geocoder: new FakeGeocoder(),
      jobs: new FakeJobs(),
      jurisdictionLookup: new CachedJurisdictionLookup(inner),
      now: () => NOW,
    })

    const first = await service.resolveForPoint(34.05, -118.25)
    const second = await service.resolveForPoint(34.05, -118.25)

    expect(second).toEqual(first)
    // The expensive part — the outbound Census request — happens ONCE for N resolves of the same point.
    expect(lookupCalls).toBe(1)
    // The idempotent insert is still attempted per call (deliberate: it self-heals a row an ops prune
    // removed, and it is a single indexed probe). What it must never do is draw a code: every statement
    // on this path is the NOT EXISTS-guarded form, whose target list is unevaluated once the row exists.
    for (const call of taggedCalls) {
      const text = call.strings.join("")
      expect(text).toContain("WHERE NOT EXISTS (SELECT 1 FROM jurisdictions WHERE geoid =")
      expect(text).not.toContain("VALUES (")
    }
  })

  it("local miss + lookup MISS -> returns null and does NOT upsert", async () => {
    const taggedCalls: TaggedCall[] = []
    const sql = makeFakeSql({ resolveRows: [], taggedCalls })
    const service = makeJurisdictionService({
      sql,
      geocoder: new FakeGeocoder(),
      jobs: new FakeJobs(),
      // Default fake returns null (no hit).
      jurisdictionLookup: new FakeJurisdictionLookup(),
      now: () => NOW,
    })

    const dto = await service.resolveForPoint(40, -100)
    expect(dto).toBeNull()
    expect(taggedCalls).toHaveLength(0)
  })

  it("local miss + dep ABSENT -> local-only behavior unchanged (null, no upsert)", async () => {
    const taggedCalls: TaggedCall[] = []
    const sql = makeFakeSql({ resolveRows: [], taggedCalls })
    const service = makeJurisdictionService({
      sql,
      geocoder: new FakeGeocoder(),
      jobs: new FakeJobs(),
      // No jurisdictionLookup dep: today's exact behavior.
      now: () => NOW,
    })

    const dto = await service.resolveForPoint(40, -100)
    expect(dto).toBeNull()
    expect(taggedCalls).toHaveLength(0)
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
