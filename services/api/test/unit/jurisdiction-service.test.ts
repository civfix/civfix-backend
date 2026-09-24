import { describe, it, expect } from "vitest"
import { FakeJobs, FakeGeocoder } from "@civfix/shared/fakes"
import type { Sql } from "../../src/db/client.js"
import {
  needsDiscovery,
  isRoutable,
  makeJurisdictionService,
  type JurisdictionHealthRow,
} from "../../src/services/jurisdiction-service.js"
import { JURISDICTION_DISCOVERY_JOB } from "../../src/lib/queue-names.js"
import {
  CachedJurisdictionLookup,
  FakeJurisdictionLookup,
  JurisdictionLookupUnavailableError,
  type JurisdictionLookup,
} from "../../src/adapters/jurisdiction-lookup.census.js"
import { makeFakeSql as makeRecordingSql } from "../helpers/fake-sql.js"

const NOW = new Date("2026-05-31T00:00:00.000Z")

interface ResolvedRow {
  geoid: string
  name: string
  layer: "place" | "county" | "state"
}

interface HealthDbRow {
  geoid: string
  contact_emails: string[] | null
  contact_updated_at: Date | null
  population: number | null
  has_routing_contact?: boolean
}

interface TaggedCall {
  strings: readonly string[]
  values: unknown[]
}

function makeFakeSql(opts: {
  resolveRows: ResolvedRow[]
  healthRows?: HealthDbRow[]
  taggedCalls?: TaggedCall[]
}): Sql {
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    opts.taggedCalls?.push({ strings: [...strings], values })
    return Promise.resolve(opts.healthRows ?? [])
  }
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
    expect(needsDiscovery({ geoid: "x", contactEmails: [], contactUpdatedAt: NOW }, NOW)).toBe(true)
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

describe("needsDiscovery (per-category routing precedence)", () => {
  it("is routable when a jurisdiction_contacts row exists even though legacy contact_emails is empty", () => {
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
    expect(needsDiscovery({ geoid: "x", contactEmails: null, contactUpdatedAt: NOW }, NOW)).toBe(
      true,
    )
    expect(
      needsDiscovery(
        { geoid: "x", contactEmails: null, contactUpdatedAt: NOW, hasRoutingContact: false },
        NOW,
      ),
    ).toBe(true)
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

describe("resolveForPoint health probe ignores bounced contacts", () => {
  it("counts neither a bounced per-category contact nor a bounced legacy address as routable", async () => {
    const recording = makeRecordingSql([
      {
        match: /has_routing_contact/,
        rows: [
          {
            geoid: "0644000",
            contact_emails: [],
            contact_updated_at: NOW,
            population: 3_900_000,
            has_routing_contact: false,
          },
        ],
      },
    ])
    const resolved: ResolvedRow = { geoid: "0644000", name: "Los Angeles", layer: "place" }
    const sql = Object.assign(recording.sql, {
      unsafe: () => Promise.resolve([resolved]),
    }) as unknown as Sql
    const jobs = new FakeJobs()
    const service = makeJurisdictionService({
      sql,
      geocoder: new FakeGeocoder(),
      jobs,
      now: () => NOW,
    })

    const dto = await service.resolveForPoint(34.1, -118.35)

    const probe = recording.statements.find((s) => /has_routing_contact/.test(s.sql))?.sql ?? ""
    const flat = probe.replace(/\s+/g, " ")
    expect(flat).toMatch(
      /FROM jurisdiction_contacts jc WHERE jc\.geoid = j\.geoid AND jc\.email IS NOT NULL AND jc\.email <> '' AND jc\.bounced_at IS NULL/,
    )
    expect(flat).toMatch(/FROM unnest\(j\.contact_emails\) AS e WHERE NOT EXISTS/)
    expect(flat).toMatch(
      /me\.type = 'bounced' AND lower\(me\.meta->>'failedRecipient'\) = lower\(e\)/,
    )
    expect(dto?.routable).toBe(false)
    expect(jobs.jobsFor(JURISDICTION_DISCOVERY_JOB)).toHaveLength(1)
  })
})

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
    expect(dto?.cityStateLabel).toBe("Los Angeles, CA")
    expect(dto?.routable).toBe(false)

    expect(taggedCalls).toHaveLength(1)
    const upsert = taggedCalls[0]!
    expect(upsert.strings.join("")).toContain("INSERT INTO jurisdictions")
    expect(upsert.strings.join("")).toContain("ON CONFLICT (geoid) DO NOTHING")
    expect(upsert.values).toEqual(["0644000", "Los Angeles", "place", 2, "0644000"])
  })

  it("F126: an UNAVAILABLE lookup (throws) stays best-effort -> null, and writes NO row", async () => {
    const taggedCalls: TaggedCall[] = []
    const sql = makeFakeSql({ resolveRows: [], taggedCalls })
    const lookup: JurisdictionLookup = {
      lookup: () => Promise.reject(new JurisdictionLookupUnavailableError("http")),
    }
    const service = makeJurisdictionService({
      sql,
      geocoder: new FakeGeocoder(),
      jobs: new FakeJobs(),
      jurisdictionLookup: lookup,
      now: () => NOW,
    })

    const dto = await service.resolveForPoint(34.05, -118.25)

    expect(dto).toBeNull()
    expect(taggedCalls).toHaveLength(0)
  })

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
    expect(lookupCalls).toBe(1)
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
