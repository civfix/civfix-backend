import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import type { CleanupStatus } from "@civfix/shared"
import { FakeGeocoder, FakeJobs } from "@civfix/shared/fakes"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { clientQuery } from "../helpers/query.js"
import { makeServer } from "../../src/server.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { makeJurisdictionService } from "../../src/services/jurisdiction-service.js"
import {
  CachedJurisdictionLookup,
  type JurisdictionLookup,
  type JurisdictionLookupResult,
} from "../../src/adapters/jurisdiction-lookup.census.js"
import {
  LA_CITY,
  LA_COUNTY,
  PROBE_COUNTY_NOT_CITY,
  PROBE_INSIDE_CITY,
  PROBE_OUTSIDE_ALL,
} from "../../src/db/seed-fixtures.js"

const pg = await withPg()

describe.skipIf(!pg)("map routes (integration)", () => {
  let h: PgHarness
  let app: FastifyInstance

  beforeAll(async () => {
    h = pg as PgHarness
    // Every other seam defaults to its fake outside production.
    const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: h.uri })
    const container = makeContainer(env)
    app = await makeServer({ env, container })
  })

  afterAll(async () => {
    await app?.close()
    await h.teardown()
  })

  it("resolves an in-city point to the place layer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/map/resolve-jurisdiction",
      payload: { lat: PROBE_INSIDE_CITY.lat, lng: PROBE_INSIDE_CITY.lng },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).not.toBeNull()
    expect(body.geoid).toBe(LA_CITY.geoid)
    expect(body.layer).toBe("place")
    expect(typeof body.cityStateLabel).toBe("string")
    expect(typeof body.routable).toBe("boolean")
  })

  it("resolves unincorporated county land to the county layer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/map/resolve-jurisdiction",
      payload: { lat: PROBE_COUNTY_NOT_CITY.lat, lng: PROBE_COUNTY_NOT_CITY.lng },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.geoid).toBe(LA_COUNTY.geoid)
    expect(body.layer).toBe("county")
  })

  it("returns 200 with a null body for a point outside all coverage", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/map/resolve-jurisdiction",
      payload: { lat: PROBE_OUTSIDE_ALL.lat, lng: PROBE_OUTSIDE_ALL.lng },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
  })

  it("GET /map/cleanups returns only pins inside the bbox, with going counts", async () => {
    const [organizer] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Organizer') RETURNING id
    `
    const [member] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Member') RETURNING id
    `
    const organizerId = organizer!.id
    const memberId = member!.id

    const insideLng = PROBE_INSIDE_CITY.lng
    const insideLat = PROBE_INSIDE_CITY.lat
    const near1Id = await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Near 1",
      lng: insideLng,
      lat: insideLat,
      scheduledAt: new Date(Date.now() + 7 * 86_400_000),
    })
    await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Near 2",
      lng: insideLng + 0.01,
      lat: insideLat + 0.01,
      scheduledAt: new Date(Date.now() + 8 * 86_400_000),
    })
    await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Far",
      lng: PROBE_OUTSIDE_ALL.lng,
      lat: PROBE_OUTSIDE_ALL.lat,
      scheduledAt: new Date(Date.now() + 9 * 86_400_000),
    })

    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role) VALUES
        (${near1Id}, ${organizerId}, 'organizer'),
        (${near1Id}, ${memberId}, 'member')
    `

    // bbox is sent as the shared client encodes it: a single JSON param.
    const [west, south, east, north] = LA_CITY.bbox
    const res = await app.inject({
      method: "GET",
      url: `/v1/map/cleanups${clientQuery({ bbox: { west, south, east, north }, when: "upcoming" })}`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const ids: string[] = body.pins.map((p: { id: string }) => p.id)
    expect(ids).toContain(near1Id)
    expect(body.pins).toHaveLength(2)

    const near1Pin = body.pins.find((p: { id: string }) => p.id === near1Id)
    expect(near1Pin.going).toBe(2)
    expect(near1Pin.lat).toBeCloseTo(insideLat, 5)
    expect(near1Pin.lng).toBeCloseTo(insideLng, 5)
  })

  it("map pins and listCleanups agree on the live-event predicate", async () => {
    const [organizer] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Predicate Organizer') RETURNING id
    `
    const organizerId = organizer!.id
    const lng = PROBE_INSIDE_CITY.lng
    const lat = PROBE_INSIDE_CITY.lat

    const insert = async (
      title: string,
      offsetMs: number,
      status: CleanupStatus,
    ): Promise<string> =>
      await seedCleanup(h.sql, {
        organizerUserId: organizerId,
        title,
        lng,
        lat,
        scheduledAt: new Date(Date.now() + offsetMs),
        status,
      })

    const stalePlanned = await insert("Stale Planned", -3 * 86_400_000, "upcoming")
    const finishedFutureDated = await insert("Finished Future Dated", 3 * 86_400_000, "done")
    const inProgress = await insert("In Progress", -2 * 3_600_000, "active")
    const stillPlanned = await insert("Still Planned", 4 * 86_400_000, "upcoming")

    const [west, south, east, north] = LA_CITY.bbox
    const bbox = { west, south, east, north }

    const noWhen = await app.inject({
      method: "GET",
      url: `/v1/map/cleanups${clientQuery({ bbox })}`,
    })
    expect(noWhen.statusCode).toBe(200)
    const noWhenIds: string[] = noWhen.json().pins.map((pin: { id: string }) => pin.id)
    expect(noWhenIds).not.toContain(stalePlanned)
    expect(noWhenIds).toContain(finishedFutureDated)
    expect(noWhenIds).toContain(inProgress)
    expect(noWhenIds).toContain(stillPlanned)

    const upcoming = await app.inject({
      method: "GET",
      url: `/v1/map/cleanups${clientQuery({ bbox, when: "upcoming" })}`,
    })
    expect(upcoming.statusCode).toBe(200)
    const upcomingIds: string[] = upcoming.json().pins.map((pin: { id: string }) => pin.id)
    expect(upcomingIds).not.toContain(stalePlanned)
    expect(upcomingIds).toContain(finishedFutureDated)
    expect(upcomingIds).toContain(inProgress)
    expect(upcomingIds).toContain(stillPlanned)

    const repo = makeDrizzleCleanupRepository(h.sql)
    const listed = await repo.listCleanups({
      when: "upcoming",
      bbox,
      near: undefined,
      cursor: null,
      limit: 50,
    })
    const listedIds = listed.records.map((r) => r.id)
    expect(listedIds).not.toContain(stalePlanned)
    expect(listedIds).toContain(finishedFutureDated)
    expect(listedIds).toContain(inProgress)
    expect(listedIds).toContain(stillPlanned)

    const listedPast = await repo.listCleanups({
      when: "past",
      bbox,
      near: undefined,
      cursor: null,
      limit: 50,
    })
    const pastIds = listedPast.records.map((r) => r.id)
    expect(pastIds).toContain(stalePlanned)
    expect(pastIds).not.toContain(inProgress)
    expect(pastIds).not.toContain(finishedFutureDated)
  })

  it("POST /map/jurisdictions/:geoid/suggest-contact 404s an unknown geoid", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/map/jurisdictions/99999999/suggest-contact",
      payload: { email: "311@example.gov" },
    })
    expect(res.statusCode).toBe(404)
  })

  it("suggest-contact records a discovery.contact_suggested audit row for a known geoid", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/map/jurisdictions/${LA_CITY.geoid}/suggest-contact`,
      payload: {
        email: "sanitation@lacity.example",
        formUrl: "https://lacity.example/report",
        note: "use the SR portal",
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ ok: true })

    const rows = await h.sql<
      { meta: { email: string; formUrl: string; note: string; source: string } }[]
    >`
      SELECT meta FROM audit_log
      WHERE action = 'discovery.contact_suggested'
        AND target = ${"jurisdiction:" + LA_CITY.geoid}
      ORDER BY created_at DESC
      LIMIT 1
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]?.meta.email).toBe("sanitation@lacity.example")
    expect(rows[0]?.meta.formUrl).toBe("https://lacity.example/report")
    expect(rows[0]?.meta.note).toBe("use the SR portal")
    expect(rows[0]?.meta.source).toBe("anon")
  })

  // The lazily-inserted row has a NULL geom, so it never satisfies the resolver's ST_Contains and every
  // repeat resolve re-enters the fallback. `nextval` in a VALUES list burned one `jurisdiction_code_seq`
  // value per request on an anon-ok endpoint (VALUES is evaluated before the conflict is detected). Only
  // a real DB can prove the NOT EXISTS guard leaves the sequence alone.
  describe("write-time Census fallback (lazy jurisdiction insert)", () => {
    const FALLBACK_GEOID = "0699999"

    async function seqState(): Promise<{ last_value: string; is_called: boolean }> {
      const rows = await h.sql<{ last_value: string; is_called: boolean }[]>`
        SELECT last_value::text, is_called FROM jurisdiction_code_seq
      `
      return rows[0]!
    }

    function serviceWith(lookup: JurisdictionLookup) {
      return makeJurisdictionService({
        sql: h.sql,
        geocoder: new FakeGeocoder(),
        jobs: new FakeJobs(),
        jurisdictionLookup: lookup,
      })
    }

    // The answer is mutable so a "Census renamed the place" case is expressible.
    function countingLookup(hit: JurisdictionLookupResult): {
      lookup: JurisdictionLookup
      calls: () => number
      setName: (name: string) => void
    } {
      let calls = 0
      let current = hit
      return {
        lookup: {
          lookup: () => {
            calls += 1
            return Promise.resolve(current)
          },
        },
        calls: () => calls,
        setName: (name: string) => {
          current = { ...current, name }
        },
      }
    }

    it("inserts the row with a JURCODE once, and a repeat resolve draws NO further sequence value", async () => {
      const probe = countingLookup({ geoid: FALLBACK_GEOID, name: "Fallback City", layer: "place" })
      const service = serviceWith(probe.lookup)

      const before = await seqState()
      const first = await service.resolveForPoint(PROBE_OUTSIDE_ALL.lat, PROBE_OUTSIDE_ALL.lng)
      expect(first?.geoid).toBe(FALLBACK_GEOID)
      expect(first?.routable).toBe(false)

      const created = await h.sql<{ code: number | null; name: string; geom: unknown }[]>`
        SELECT code, name, geom FROM jurisdictions WHERE geoid = ${FALLBACK_GEOID}
      `
      expect(created).toHaveLength(1)
      expect(created[0]?.code).not.toBeNull()
      expect(created[0]?.geom).toBeNull()

      const afterInsert = await seqState()
      expect(afterInsert.is_called).toBe(true)
      expect(Number(afterInsert.last_value)).toBeGreaterThanOrEqual(Number(before.last_value))

      await service.resolveForPoint(PROBE_OUTSIDE_ALL.lat, PROBE_OUTSIDE_ALL.lng)
      await service.resolveForPoint(PROBE_OUTSIDE_ALL.lat, PROBE_OUTSIDE_ALL.lng)
      expect(probe.calls()).toBe(3)

      const afterRepeats = await seqState()
      expect(afterRepeats.last_value).toBe(afterInsert.last_value)

      const still = await h.sql<{ code: number | null }[]>`
        SELECT code FROM jurisdictions WHERE geoid = ${FALLBACK_GEOID}
      `
      expect(still).toHaveLength(1)
      expect(still[0]?.code).toBe(created[0]?.code)
    })

    it("leaves the existing row untouched (the boundary ingest owns name/layer refreshes)", async () => {
      const probe = countingLookup({ geoid: FALLBACK_GEOID, name: "Fallback City", layer: "place" })
      const service = serviceWith(probe.lookup)
      await service.resolveForPoint(PROBE_OUTSIDE_ALL.lat, PROBE_OUTSIDE_ALL.lng)

      // The stored row keeps its name, so this fallback can never overwrite a curated or ingested one.
      probe.setName("Renamed By Census")
      const dto = await service.resolveForPoint(PROBE_OUTSIDE_ALL.lat, PROBE_OUTSIDE_ALL.lng)
      expect(dto?.geoid).toBe(FALLBACK_GEOID)

      const rows = await h.sql<{ name: string }[]>`
        SELECT name FROM jurisdictions WHERE geoid = ${FALLBACK_GEOID}
      `
      expect(rows[0]?.name).toBe("Fallback City")
    })

    it("the map wiring's memo (CachedJurisdictionLookup) makes one outbound lookup for N resolves", async () => {
      const probe = countingLookup({ geoid: FALLBACK_GEOID, name: "Fallback City", layer: "place" })
      const cached = new CachedJurisdictionLookup(probe.lookup)
      const service = serviceWith(cached)

      const before = await seqState()
      await service.resolveForPoint(PROBE_OUTSIDE_ALL.lat, PROBE_OUTSIDE_ALL.lng)
      await service.resolveForPoint(PROBE_OUTSIDE_ALL.lat, PROBE_OUTSIDE_ALL.lng)
      await service.resolveForPoint(PROBE_OUTSIDE_ALL.lat, PROBE_OUTSIDE_ALL.lng)

      expect(probe.calls()).toBe(1)
      // The row already exists from the tests above.
      expect((await seqState()).last_value).toBe(before.last_value)
    })
  })
})
