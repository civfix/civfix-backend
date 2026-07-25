/**
 * Map routes integration test (Docker-gated). Boots the real Fastify app against a live PostGIS
 * container (via withPg, which seeds the canonical jurisdiction set) and exercises the DB-backed map
 * endpoints end-to-end through app.inject:
 *
 *   POST /map/resolve-jurisdiction  -> place for an in-city point, county for unincorporated land,
 *                                      and 200-null for a far point outside all coverage.
 *   GET  /map/cleanups              -> returns the pins whose Point falls inside the queried bbox,
 *                                      with a "going" count, and excludes ones outside the bbox.
 *
 * When Docker is unavailable the whole describe block SKIPS (describe.skipIf) so the local suite stays
 * green; CI runs it for real. Reuses withPg() per the harness contract.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeGeocoder, FakeJobs } from "@civfix/shared/fakes"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { clientQuery } from "../helpers/query.js"
import { buildServer } from "../../src/server.js"
import { buildContainer } from "../../src/di.js"
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
    // Real DB; everything else stays a fake (jobs/geocoder/etc. default to fakes outside production).
    const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: h.uri })
    const container = buildContainer(env)
    app = await buildServer({ env, container })
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
    // The public DTO now carries the routable flag (whether routing is configured for this jurisdiction).
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
    // One organizer user + one extra member so the going count is observable.
    const [organizer] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Organizer') RETURNING id
    `
    const [member] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Member') RETURNING id
    `
    const organizerId = organizer!.id
    const memberId = member!.id

    // Two cleanups inside the LA city box (near PROBE_INSIDE_CITY) and one far outside it.
    const insideLng = PROBE_INSIDE_CITY.lng
    const insideLat = PROBE_INSIDE_CITY.lat
    const [near1] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanups (organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${organizerId}, 'site', 'Near 1',
        ST_SetSRID(ST_MakePoint(${insideLng}, ${insideLat}), 4326),
        now() + interval '7 days', 'upcoming'
      ) RETURNING id
    `
    await h.sql`
      INSERT INTO cleanups (organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${organizerId}, 'site', 'Near 2',
        ST_SetSRID(ST_MakePoint(${insideLng + 0.01}, ${insideLat + 0.01}), 4326),
        now() + interval '8 days', 'upcoming'
      )
    `
    // Far away (outside the LA city bbox we will query).
    await h.sql`
      INSERT INTO cleanups (organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${organizerId}, 'site', 'Far',
        ST_SetSRID(ST_MakePoint(${PROBE_OUTSIDE_ALL.lng}, ${PROBE_OUTSIDE_ALL.lat}), 4326),
        now() + interval '9 days', 'upcoming'
      )
    `

    // Two members going to near1 (organizer + member).
    const near1Id = near1!.id
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role) VALUES
        (${near1Id}, ${organizerId}, 'organizer'),
        (${near1Id}, ${memberId}, 'member')
    `

    // Query the LA city box (LA_CITY.bbox = [xmin(lng), ymin(lat), xmax(lng), ymax(lat)]). bbox is sent
    // as the shared client encodes it (a single JSON param), via clientQuery.
    const [west, south, east, north] = LA_CITY.bbox
    const res = await app.inject({
      method: "GET",
      url: `/v1/map/cleanups${clientQuery({ bbox: { west, south, east, north }, when: "upcoming" })}`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const ids: string[] = body.pins.map((p: { id: string }) => p.id)
    // Both near cleanups are inside; the far one is not.
    expect(ids).toContain(near1Id)
    expect(body.pins).toHaveLength(2)

    const near1Pin = body.pins.find((p: { id: string }) => p.id === near1Id)
    expect(near1Pin.going).toBe(2)
    expect(near1Pin.lat).toBeCloseTo(insideLat, 5)
    expect(near1Pin.lng).toBeCloseTo(insideLng, 5)
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

  /**
   * The write-time Census fallback against a REAL sequence (A15 follow-up).
   *
   * The lazily-inserted row has a NULL geom, so it can never satisfy the resolver's ST_Contains — every
   * repeat resolve of the same point re-enters the fallback. With `nextval` in a VALUES list that burned one
   * `jurisdiction_code_seq` value per request (VALUES is evaluated before the conflict is detected), on an
   * anon-ok endpoint. Only a real DB can prove the NOT EXISTS guard actually leaves the sequence alone.
   */
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

    /** Counting lookup with a mutable answer, so a "Census renamed the place" case is expressible. */
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
      // NULL geom is what makes this row un-resolvable spatially (hence the repeat-call path below).
      expect(created[0]?.geom).toBeNull()

      const afterInsert = await seqState()
      // The insert drew from the sequence (the stamped code above), so it has been called and cannot have
      // gone backwards.
      expect(afterInsert.is_called).toBe(true)
      expect(Number(afterInsert.last_value)).toBeGreaterThanOrEqual(Number(before.last_value))

      // Two more resolves of the same point: the lookup answers again (uncached service), the row already
      // exists, and the sequence must not move.
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

      // A later lookup answers with a different label for the same geoid: the stored row keeps its name,
      // so this fallback can never overwrite a curated/ingested one.
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
      // Row already existed from the tests above, so nothing was drawn at all here.
      expect((await seqState()).last_value).toBe(before.last_value)
    })
  })
})
