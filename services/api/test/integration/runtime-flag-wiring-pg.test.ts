/**
 * The outreach digest and auto-forward read their runtime flag at the moment they act (#252), through the
 * real Fastify app and job handlers on PostGIS. The container's flag service is swapped per case for one
 * over an in-memory store (built once, then flipped); everything else is the container's own wiring, so
 * every case runs the SQL production runs. The pure wiring cases are in test/unit/runtime-flag-wiring.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import type { FakeJobs, FakeMailer } from "@civfix/seams"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { makeServer } from "../../src/server.js"
import { makeContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { PgAuthStores } from "../../src/auth/pg-stores.js"
import { makeAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { registerOutreachJobs } from "../../src/services/admin/outreach-jobs.js"
import { registerAutoForwardJobs } from "../../src/services/admin/autoforward-jobs.js"
import type { RuntimeFlagService } from "../../src/services/admin/runtime-flag-service.js"
import { OUTREACH_DIGEST_JOB, REPORT_AUTOFORWARD_JOB } from "../../src/lib/queue-names.js"
import { LA_CITY, PROBE_INSIDE_CITY } from "../../src/db/seed-fixtures.js"
import {
  ENV_SWITCH_VALUES,
  HandlerJobs,
  OPERATOR_ID,
  envWith,
  flagHarness,
} from "../helpers/runtime-flags.js"

const pg = await withPg()

const OPERATOR_EMAIL = "ops-flags@civfix.test"
const GEOID = LA_CITY.geoid
const CONTACT = "clerk@lacity.gov"

interface Resident {
  userId: string
  cookie: string
  csrfToken: string
}

describe.skipIf(!pg)("runtime flags read at the moment of the check (integration)", () => {
  let h: PgHarness
  let app: FastifyInstance
  let container: Container
  let authServices: AuthServices
  let flags: RuntimeFlagService
  let mailer: FakeMailer
  let serverJobs: FakeJobs
  const workerJobs = new HandlerJobs()

  beforeAll(async () => {
    h = pg as PgHarness
    const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: h.uri, ADMIN_EMAILS: OPERATOR_EMAIL })
    container = { ...makeContainer(env), getRuntimeFlags: () => flags }
    authServices = makeAuthServices({
      stores: new PgAuthStores(container.getDb().db, {
        certificateObjects: container.storage,
        notifier: container.getNotificationService(),
        jobs: container.jobs,
      }),
      cache: new InMemoryCacheClient(),
      mailer: container.mailer,
      oauthConfig: {},
    })
    app = await makeServer({ env, container, authServices })
    mailer = container.mailer as FakeMailer
    serverJobs = container.jobs as FakeJobs
    // The handlers get their own jobs so the server's enqueues are recorded, not run.
    const workers: Container = { ...container, jobs: workerJobs }
    await registerOutreachJobs(workers)
    await registerAutoForwardJobs(workers)
  })

  afterAll(async () => {
    await app?.close()
    await h.teardown()
  })

  beforeEach(async () => {
    flags = flagHarness().flags
    await resetOutreach()
    await h.sql`DELETE FROM jurisdiction_contacts`
    await h.sql`UPDATE jurisdictions SET contact_emails = NULL`
    await setContact(CONTACT)
    serverJobs.reset()
    workerJobs.reset()
  })

  async function resetOutreach(): Promise<void> {
    await h.sql`TRUNCATE mail_events, mail_messages, mail_threads, outreach_state RESTART IDENTITY CASCADE`
    await h.sql`DELETE FROM audit_log WHERE action = 'outreach.digest_sent'`
    mailer.sent.length = 0
  }

  async function setContact(email: string): Promise<void> {
    await h.sql`
      INSERT INTO jurisdiction_contacts (geoid, category, email, updated_at)
      VALUES (${GEOID}, NULL, ${email}, now())
      ON CONFLICT (geoid) WHERE category IS NULL
      DO UPDATE SET email = EXCLUDED.email, updated_at = now()
    `
  }

  async function report(): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        idempotency_key, geom, geom_source, category, type, status, visibility, h3_cell, jurisdiction_geoid
      ) VALUES (
        ${randomUUID()}, ST_SetSRID(ST_MakePoint(${PROBE_INSIDE_CITY.lng}, ${PROBE_INSIDE_CITY.lat}), 4326),
        'device', 'trash', 'dump', 'published', 'public', 'h0', ${GEOID}
      )
      RETURNING id
    `
    return row!.id
  }

  async function resident(opts: { email?: string; role?: "citizen" | "operator" } = {}) {
    const handle = testHandle()
    const role = opts.role ?? "citizen"
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, email, email_verified, role)
      VALUES (${`Resident ${handle}`}, ${handle}, ${opts.email ?? null}, ${opts.email !== undefined},
              ${role})
      RETURNING id
    `
    const userId = u!.id
    await h.sql`INSERT INTO user_moderation (user_id, report_verified) VALUES (${userId}, true)`
    const token = await authServices.sessions.createSession(userId, [role])
    const csrfToken = await container.csrf.tokenForSession(token)
    return { userId, cookie: `civfix_session=${token}`, csrfToken } satisfies Resident
  }

  let operatorSession: Promise<Resident> | undefined
  function operator(): Promise<Resident> {
    operatorSession ??= resident({ email: OPERATOR_EMAIL, role: "operator" })
    return operatorSession
  }

  function citySent(): number {
    return mailer.sent.filter((m) => m.to === CONTACT).length
  }

  async function digestAudits(): Promise<{ target: string }[]> {
    return h.sql<{ target: string }[]>`
      SELECT target FROM audit_log WHERE action = 'outreach.digest_sent'
    `
  }

  async function routedAudits(reportId: string): Promise<number> {
    const [row] = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log
      WHERE action = 'report.routed' AND target = ${`report:${reportId}`}
    `
    return row!.n
  }

  function runDigest(data: Record<string, unknown>): Promise<void> {
    return workerJobs.handler(OUTREACH_DIGEST_JOB)({ id: randomUUID(), data })
  }

  function runAutoForward(reportId: string): Promise<void> {
    return workerJobs.handler(REPORT_AUTOFORWARD_JOB)({ id: randomUUID(), data: { reportId } })
  }

  async function canForwardToCity(reportId: string, as?: Resident): Promise<unknown> {
    const res: LightMyRequestResponse = await app.inject({
      method: "GET",
      url: `/v1/reports/${reportId}`,
      headers: as !== undefined ? { cookie: as.cookie } : {},
    })
    expect(res.statusCode).toBe(200)
    return res.json().canForwardToCity
  }

  async function createReport(as: Resident): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { cookie: as.cookie, "x-csrf-token": as.csrfToken },
      payload: {
        idempotencyKey: randomUUID(),
        category: "trash",
        type: "dump",
        lat: PROBE_INSIDE_CITY.lat,
        lng: PROBE_INSIDE_CITY.lng,
        geomSource: "device",
        mediaUploadIds: [],
      },
    })
    expect(res.statusCode).toBe(201)
    return res.json().id
  }

  async function saveContacts(as: Resident): Promise<number> {
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/jurisdictions/${GEOID}/contacts`,
      headers: { cookie: as.cookie, "x-csrf-token": as.csrfToken },
      payload: { contacts: {}, defaultEmails: [CONTACT], formUrl: null },
    })
    return res.statusCode
  }

  it("T8: each digest run reads outreach_digest_enabled when it runs", async () => {
    await report()

    await expect(runDigest({})).resolves.toBeUndefined()
    await expect(runDigest({ geoid: GEOID })).resolves.toBeUndefined()
    expect(citySent()).toBe(0)
    expect(await digestAudits()).toEqual([])
    expect(workerJobs.enqueued).toEqual([])

    await flags.set("outreach_digest_enabled", true, OPERATOR_ID)
    await runDigest({})
    expect(citySent()).toBe(1)
    expect(await digestAudits()).toEqual([{ target: `jurisdiction:${GEOID}` }])

    await flags.set("outreach_digest_enabled", false, OPERATOR_ID)
    // A clean throttle window, so only the flag can stop this run.
    await resetOutreach()
    await runDigest({})
    expect(citySent()).toBe(0)
    expect(await digestAudits()).toEqual([])
  })

  it("T12: each auto-forward job reads report_autoforward_enabled when it runs", async () => {
    const [first, second, third] = [await report(), await report(), await report()]

    await expect(runAutoForward(first)).resolves.toBeUndefined()
    expect(citySent()).toBe(0)
    expect(await routedAudits(first)).toBe(0)

    await flags.set("report_autoforward_enabled", true, OPERATOR_ID)
    await runAutoForward(second)
    expect(mailer.sent.map((m) => m.to)).toEqual([CONTACT])
    expect(await routedAudits(second)).toBe(1)

    await flags.set("report_autoforward_enabled", false, OPERATOR_ID)
    await expect(runAutoForward(third)).resolves.toBeUndefined()
    expect(citySent()).toBe(1)
    expect(await routedAudits(third)).toBe(0)
  })

  it("T14: canForwardToCity follows report_autoforward_enabled set and cleared", async () => {
    const id = await report()

    expect(await canForwardToCity(id)).toBe(false)
    await flags.set("report_autoforward_enabled", true, OPERATOR_ID)
    expect(await canForwardToCity(id)).toBe(true)
    await flags.set("report_autoforward_enabled", null, OPERATOR_ID)
    expect(await canForwardToCity(id)).toBe(false)
  })

  it("T15: canForwardToCity stays false with the flag on and no contact email", async () => {
    await flags.set("report_autoforward_enabled", true, OPERATOR_ID)
    const id = await report()

    await h.sql`DELETE FROM jurisdiction_contacts`
    expect(await canForwardToCity(id)).toBe(false)

    await setContact("")
    expect(await canForwardToCity(id)).toBe(false)
  })

  describe("T17: with no override, each switch reads its env var as parseBool(raw, false)", () => {
    it.each(ENV_SWITCH_VALUES)(
      "OUTREACH_DIGEST_ENABLED=$raw: the digest run and the contact save act only when $on",
      async ({ raw, on }) => {
        flags = flagHarness(envWith("OUTREACH_DIGEST_ENABLED", raw)).flags
        await report()

        await runDigest({})
        expect(citySent()).toBe(on ? 1 : 0)

        await resetOutreach()
        expect(await saveContacts(await operator())).toBe(200)
        expect(serverJobs.jobsFor(OUTREACH_DIGEST_JOB)).toHaveLength(on ? 1 : 0)
      },
    )

    it.each(ENV_SWITCH_VALUES)(
      "REPORT_AUTOFORWARD_ENABLED=$raw: submission, canForwardToCity and the job forward only when $on",
      async ({ raw, on }) => {
        flags = flagHarness(envWith("REPORT_AUTOFORWARD_ENABLED", raw)).flags
        const reporter = await resident()

        const id = await createReport(reporter)
        expect(serverJobs.jobsFor(REPORT_AUTOFORWARD_JOB)).toHaveLength(on ? 1 : 0)
        expect(await canForwardToCity(id, reporter)).toBe(on)

        await runAutoForward(id)
        expect(citySent()).toBe(on ? 1 : 0)
      },
    )
  })
})
