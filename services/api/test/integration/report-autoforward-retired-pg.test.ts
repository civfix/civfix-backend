/**
 * The retired report.autoforward job, through the real Fastify app on PostGIS with the production report
 * wiring (no reportOverrides): REPORT_AUTOFORWARD_ENABLED no longer enqueues anything at submission and
 * gates only the canForwardToCity hint on the report detail.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { FakeJobs } from "@civfix/seams"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { makeServer } from "../../src/server.js"
import { makeContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { PgAuthStores } from "../../src/auth/pg-stores.js"
import { makeAuthServices, type AuthServices } from "../../src/auth/auth-services.js"

const pg = await withPg()

interface Built {
  app: FastifyInstance
  container: Container
  authServices: AuthServices
}

interface Resident {
  userId: string
  cookie: string
  csrfToken: string
}

describe.skipIf(!pg)("report.autoforward retired (integration)", () => {
  let h: PgHarness
  let on: Built
  let off: Built

  async function build(flag: boolean): Promise<Built> {
    const env = loadEnv({
      NODE_ENV: "test",
      DATABASE_URL: h.uri,
      REPORT_AUTOFORWARD_ENABLED: String(flag),
    })
    const container = makeContainer(env)
    const authServices = makeAuthServices({
      stores: new PgAuthStores(container.getDb().db, {
        certificateObjects: container.storage,
        notifier: container.getNotificationService(),
        jobs: container.jobs,
      }),
      cache: new InMemoryCacheClient(),
      mailer: container.mailer,
      oauthConfig: {},
    })
    const app = await makeServer({ env, container, authServices })
    return { app, container, authServices }
  }

  beforeAll(async () => {
    h = pg as PgHarness
    on = await build(true)
    off = await build(false)
  })

  afterAll(async () => {
    await on?.app.close()
    await off?.app.close()
    await h.teardown()
  })

  async function verifiedReporter(server: Built): Promise<Resident> {
    const handle = testHandle()
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, role)
      VALUES (${`Resident ${handle}`}, ${handle}, 'citizen')
      RETURNING id
    `
    const userId = u!.id
    await h.sql`
      INSERT INTO user_moderation (user_id, report_verified, report_verified_at)
      VALUES (${userId}, true, now())
    `
    const token = await server.authServices.sessions.createSession(userId, ["citizen"])
    const csrfToken = await server.container.csrf.tokenForSession(token)
    return { userId, cookie: `civfix_session=${token}`, csrfToken }
  }

  /** A jurisdiction of its own, off the LA seed, so its contacts are exactly what the case inserts. */
  async function jurisdiction(): Promise<string> {
    const geoid = `t${randomUUID().slice(0, 8)}`
    await h.sql`
      INSERT INTO jurisdictions (geoid, name, layer, priority, geom)
      VALUES (${geoid}, ${`Test city ${geoid}`}, 'place', 0,
              ST_Multi(ST_MakeEnvelope(-140.01, 10.0, -140.0, 10.01, 4326)))
    `
    return geoid
  }

  async function reportIn(geoid: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        idempotency_key, geom, geom_source, category, type, title, status, visibility, h3_cell,
        jurisdiction_geoid
      ) VALUES (
        ${randomUUID()}, ST_SetSRID(ST_MakePoint(-140.005, 10.005), 4326), 'device', 'trash', 'dump',
        'Overflowing bin', 'published', 'public', 'h0', ${geoid}
      )
      RETURNING id
    `
    return row!.id
  }

  function getReport(server: Built, id: string) {
    return server.app.inject({ method: "GET", url: `/v1/reports/${id}` })
  }

  it("T1: a verified reporter's report with REPORT_AUTOFORWARD_ENABLED on enqueues no report.autoforward job", async () => {
    const reporter = await verifiedReporter(on)
    const res = await on.app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { cookie: reporter.cookie, "x-csrf-token": reporter.csrfToken },
      payload: {
        idempotencyKey: randomUUID(),
        category: "trash",
        type: "dump",
        lat: 34.05,
        lng: -118.25,
        geomSource: "device",
        mediaUploadIds: [],
      },
    })
    expect(res.statusCode).toBe(201)
    expect((on.container.jobs as FakeJobs).jobsFor("report.autoforward")).toHaveLength(0)
  })

  describe("canForwardToCity", () => {
    let withContact: string

    beforeAll(async () => {
      const geoid = await jurisdiction()
      await h.sql`
        INSERT INTO jurisdiction_contacts (geoid, category, email)
        VALUES (${geoid}, NULL, 'forward@city.test')
      `
      withContact = await reportIn(geoid)
    })

    it("T2: true with the flag on and a usable contact", async () => {
      const res = await getReport(on, withContact)
      expect(res.statusCode).toBe(200)
      expect(res.json().canForwardToCity).toBe(true)
    })

    it("T3: false with the flag off for the same report and contact", async () => {
      const res = await getReport(off, withContact)
      expect(res.statusCode).toBe(200)
      expect(res.json().canForwardToCity).toBe(false)
    })

    it("T4: false with the flag on and no usable contact", async () => {
      const id = await reportIn(await jurisdiction())
      const res = await getReport(on, id)
      expect(res.statusCode).toBe(200)
      expect(res.json().canForwardToCity).toBe(false)
    })
  })
})
