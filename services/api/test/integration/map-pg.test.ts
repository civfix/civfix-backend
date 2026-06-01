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
import { withPg, type PgHarness } from "../helpers/pg.js"
import { clientQuery } from "../helpers/query.js"
import { buildServer } from "../../src/server.js"
import { buildContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
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
      url: "/map/resolve-jurisdiction",
      payload: { lat: PROBE_INSIDE_CITY.lat, lng: PROBE_INSIDE_CITY.lng },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).not.toBeNull()
    expect(body.geoid).toBe(LA_CITY.geoid)
    expect(body.layer).toBe("place")
    expect(typeof body.cityStateLabel).toBe("string")
  })

  it("resolves unincorporated county land to the county layer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/map/resolve-jurisdiction",
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
      url: "/map/resolve-jurisdiction",
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
      url: `/map/cleanups${clientQuery({ bbox: { west, south, east, north }, when: "upcoming" })}`,
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
})
