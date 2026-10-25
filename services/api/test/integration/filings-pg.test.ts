/**
 * City filing on PostGIS: routeReport recording its filing and the Reject / Remove / moderation cancels
 * through the real Fastify app with the container's own wiring (FakeMailer, FakeJobs), the 0211
 * backfill applied as the migration runner does, getOutreach's packetsSince, and the filer's run packet.
 */

import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import type { FakeJobs, FakeMailer, OutboundEmail } from "@civfix/seams"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { makeServer } from "../../src/server.js"
import { makeContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { PgAuthStores } from "../../src/auth/pg-stores.js"
import { makeAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { makeDrizzleAdminReportRepository } from "../../src/services/admin/admin-report-repository.drizzle.js"
import { makeFilingsWorker } from "../../src/services/filings/filings-worker.js"

const pg = await withPg()

const OPERATOR_EMAIL = "ops-filings@civfix.test"
const DRIZZLE_DIR = fileURLToPath(new URL("../../drizzle/", import.meta.url))

interface Built {
  app: FastifyInstance
  container: Container
  authServices: AuthServices
}

interface Session {
  userId: string
  cookie: string
  csrfToken: string
}

interface FilingRow {
  id: string
  status: string
  method: string | null
  channel: string | null
  route_category: string | null
  mail_thread_id: string | null
  submitted_at: Date | null
  created_at: Date
  ticket_text: string
  geoid: string | null
  category: string
}

describe.skipIf(!pg)("city filing (integration)", () => {
  let h: PgHarness
  let main: Built
  let op: Session

  async function build(extra: Record<string, string> = {}): Promise<Built> {
    const env = loadEnv({
      NODE_ENV: "test",
      DATABASE_URL: h.uri,
      ADMIN_EMAILS: OPERATOR_EMAIL,
      ...extra,
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

  async function user(
    server: Built,
    opts: { email?: string; role?: "citizen" | "operator" } = {},
  ): Promise<Session> {
    const handle = testHandle()
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, email, email_verified, role)
      VALUES (${`User ${handle}`}, ${handle}, ${opts.email ?? null}, ${opts.email !== undefined},
              ${opts.role ?? "citizen"})
      RETURNING id
    `
    const token = await server.authServices.sessions.createSession(u!.id, [opts.role ?? "citizen"])
    const csrfToken = await server.container.csrf.tokenForSession(token)
    return { userId: u!.id, cookie: `civfix_session=${token}`, csrfToken }
  }

  beforeAll(async () => {
    h = pg as PgHarness
    main = await build()
    op = await user(main, { email: OPERATOR_EMAIL, role: "operator" })
  })

  afterAll(async () => {
    await main?.app.close()
    await h.teardown()
  })

  /** A jurisdiction of its own, so its contacts and routes are exactly what the case inserts. */
  async function jurisdiction(
    contact: string | null = null,
  ): Promise<{ geoid: string; name: string }> {
    const geoid = `f${randomUUID().slice(0, 8)}`
    const name = `Filing city ${geoid}`
    await h.sql`
      INSERT INTO jurisdictions (geoid, name, layer, priority, geom)
      VALUES (${geoid}, ${name}, 'place', 0,
              ST_Multi(ST_MakeEnvelope(-141.01, 11.0, -141.0, 11.01, 4326)))
    `
    if (contact !== null) {
      await h.sql`
        INSERT INTO jurisdiction_contacts (geoid, category, email) VALUES (${geoid}, NULL, ${contact})
      `
    }
    return { geoid, name }
  }

  async function report(
    geoid: string | null,
    opts: { reporterId?: string | null; status?: string; addr?: string | null } = {},
  ): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        reporter_user_id, idempotency_key, geom, geom_source, category, type, title, status,
        visibility, h3_cell, jurisdiction_geoid, addr
      ) VALUES (
        ${opts.reporterId ?? null}, ${randomUUID()}, ST_SetSRID(ST_MakePoint(-141.005, 11.005), 4326),
        'device', 'graffiti', 'graffiti', 'Tagged wall', ${opts.status ?? "published"}, 'public', 'h0',
        ${geoid}, ${opts.addr ?? null}
      )
      RETURNING id
    `
    return row!.id
  }

  async function filingsOf(reportId: string): Promise<FilingRow[]> {
    return h.sql<FilingRow[]>`
      SELECT id, status, method, channel, route_category, mail_thread_id, submitted_at, created_at,
             ticket_text, geoid, category
      FROM report_filings WHERE report_id = ${reportId} ORDER BY created_at, id
    `
  }

  async function routeEntries(reportId: string): Promise<string[]> {
    const rows = await h.sql<{ note: string }[]>`
      SELECT note FROM report_timeline WHERE report_id = ${reportId} AND kind = 'route'
      ORDER BY created_at, id
    `
    return rows.map((r) => r.note)
  }

  async function reportStatus(reportId: string): Promise<string> {
    const [row] = await h.sql<
      { status: string }[]
    >`SELECT status FROM reports WHERE id = ${reportId}`
    return row!.status
  }

  async function insertFiling(
    reportId: string,
    geoid: string | null,
    status: string,
    extra: { cityClosedAt?: Date | null; attempts?: number } = {},
  ): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO report_filings (report_id, geoid, category, channel, status, ticket_text,
                                  city_closed_at, attempts, submitted_at, run_id)
      VALUES (${reportId}, ${geoid}, 'graffiti', 'email', ${status}, 'Tagged wall',
              ${extra.cityClosedAt ?? null}, ${extra.attempts ?? 0},
              ${status === "submitted" ? new Date() : null},
              ${status === "running" ? randomUUID() : null})
      RETURNING id
    `
    return row!.id
  }

  async function filingStatus(id: string): Promise<string> {
    const [row] = await h.sql<
      { status: string }[]
    >`SELECT status FROM report_filings WHERE id = ${id}`
    return row!.status
  }

  function post(server: Built, url: string, payload: object = {}): Promise<LightMyRequestResponse> {
    return server.app.inject({
      method: "POST",
      url,
      headers: { cookie: op.cookie, "x-csrf-token": op.csrfToken },
      payload,
    })
  }

  function mailer(server: Built): FakeMailer {
    return server.container.mailer as FakeMailer
  }

  function outboundCount(server: Built): number {
    return mailer(server).sent.filter((m) => m.outbound !== undefined).length
  }

  describe("routeReport", () => {
    it("C11: a fresh report is sent as before and recorded as one submitted email filing with one route entry", async () => {
      const j = await jurisdiction("graffiti@city.test")
      const reporter = await user(main)
      const id = await report(j.geoid, { reporterId: reporter.userId })

      const res = await post(main, `/v1/admin/reports/${id}/route`)
      expect(res.statusCode).toBe(200)
      const body = res.json<{ ok: boolean; threadId: string; routedTo: string }>()
      expect(body).toEqual({
        ok: true,
        threadId: expect.any(String),
        routedTo: "graffiti@city.test",
      })

      const filings = await filingsOf(id)
      expect(filings).toHaveLength(1)
      expect(filings[0]).toMatchObject({
        status: "submitted",
        method: "email",
        channel: "email",
        route_category: null,
        mail_thread_id: body.threadId,
      })
      expect(await reportStatus(id)).toBe("acknowledged")
      expect(await routeEntries(id)).toEqual([`Filed with ${j.name}`])
      const notes = await h.sql<{ title: string }[]>`
        SELECT title FROM notifications WHERE user_id = ${reporter.userId} AND type = 'report_update'
      `
      expect(notes.map((n) => n.title)).toEqual([`Your report was sent to ${j.name}`])
    })

    it("C12: an active filing, an open submitted filing and a rejected verdict are each a CONFLICT before any send", async () => {
      const j = await jurisdiction("conflict@city.test")

      const active = await report(j.geoid)
      await insertFiling(active, j.geoid, "needs_human")
      const open = await report(j.geoid)
      await insertFiling(open, j.geoid, "submitted")
      const rejected = await report(j.geoid)
      await h.sql`UPDATE reports SET verification_verdict = 'rejected' WHERE id = ${rejected}`

      for (const id of [active, open, rejected]) {
        const before = outboundCount(main)
        const res = await post(main, `/v1/admin/reports/${id}/route`)
        expect(res.statusCode, id).toBe(409)
        expect(res.json()).toMatchObject({ code: "CONFLICT" })
        expect(outboundCount(main)).toBe(before)
      }
    })

    it("C13: a send past its deadline is a CONFLICT, and the late delivery records one filing and one entry", async () => {
      const slow = await build({
        OCI_EMAIL_SMTP_TIMEOUT_MS: "1",
        OUTBOUND_SEND_MIN_THROUGHPUT_BPS: "1000000000",
      })
      try {
        const j = await jurisdiction("late@city.test")
        const id = await report(j.geoid)
        const fake = mailer(slow)
        const send = fake.sendOutbound.bind(fake)
        let release: () => void = () => {}
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        fake.sendOutbound = async (email: OutboundEmail) => {
          await gate
          return send(email)
        }

        const res = await post(slow, `/v1/admin/reports/${id}/route`)
        expect(res.statusCode).toBe(409)
        expect(await filingsOf(id)).toEqual([])

        release()
        await vi.waitFor(async () => expect(await filingsOf(id)).toHaveLength(1), {
          timeout: 5000,
        })
        expect((await filingsOf(id))[0]).toMatchObject({ status: "submitted", method: "email" })
        expect(await routeEntries(id)).toEqual([`Filed with ${j.name}`])
      } finally {
        await slow.app.close()
      }
    })

    /** A report routed once, whose packet then bounced. */
    async function routedThenBounced(): Promise<{ id: string; name: string; threadId: string }> {
      const j = await jurisdiction("bounce@city.test")
      const id = await report(j.geoid)
      const res = await post(main, `/v1/admin/reports/${id}/route`)
      expect(res.statusCode).toBe(200)
      const { threadId } = res.json<{ threadId: string }>()
      await h.sql`UPDATE mail_threads SET status = 'bounced' WHERE id = ${threadId}`
      return { id, name: j.name, threadId }
    }

    it("C45: a submitted email filing whose thread bounced does not block sending again, and the send is recorded as a new filing", async () => {
      const { id, threadId: bouncedThread } = await routedThenBounced()
      const before = outboundCount(main)

      const res = await post(main, `/v1/admin/reports/${id}/route`)
      expect(res.statusCode).toBe(200)
      const body = res.json<{ ok: boolean; threadId: string; routedTo: string }>()
      expect(body).toEqual({ ok: true, threadId: expect.any(String), routedTo: "bounce@city.test" })
      expect(outboundCount(main)).toBe(before + 1)

      const filings = await filingsOf(id)
      expect(filings).toHaveLength(2)
      expect(filings[0]).toMatchObject({ status: "submitted", mail_thread_id: bouncedThread })
      expect(filings[1]).toMatchObject({
        status: "submitted",
        method: "email",
        channel: "email",
        mail_thread_id: body.threadId,
      })
    })

    it("C47: after the bounce and before a new send, the report still shows the bounced filing", async () => {
      const { id, name } = await routedThenBounced()
      const res = await main.app.inject({ method: "GET", url: `/v1/reports/${id}` })
      expect(res.statusCode).toBe(200)
      const dto = res.json<{ filing: { jurisdictionName: string | null } | null; gov: boolean }>()
      expect(dto.filing).toMatchObject({ jurisdictionName: name })
      expect(dto.gov).toBe(true)
    })
  })

  describe("cancels", () => {
    async function moderationItem(reportId: string): Promise<string> {
      const [row] = await h.sql<{ id: string }[]>`
        INSERT INTO moderation_items (kind, subject_type, subject_id, flag, status)
        VALUES ('image', 'report', ${reportId}, 'manual', 'open')
        RETURNING id
      `
      return row!.id
    }

    const actions: Record<string, (reportId: string) => Promise<LightMyRequestResponse>> = {
      reject: (id) => post(main, `/v1/admin/reports/${id}/verdict`, { verdict: "rejected" }),
      remove: (id) => post(main, `/v1/admin/reports/${id}/remove`, {}),
      moderationRemove: async (id) =>
        post(main, `/v1/admin/moderation/${await moderationItem(id)}/remove`, {}),
      moderationHold: async (id) =>
        post(main, `/v1/admin/moderation/${await moderationItem(id)}/hold`, {}),
    }

    it("C14: Reject, Remove and a moderation remove cancel a queued filing, a hold does not; a running filing is left running", async () => {
      const j = await jurisdiction()
      const expected: Record<string, string> = {
        reject: "cancelled",
        remove: "cancelled",
        moderationRemove: "cancelled",
        moderationHold: "queued",
      }
      for (const [name, act] of Object.entries(actions)) {
        const id = await report(j.geoid)
        const filing = await insertFiling(id, j.geoid, "queued")
        const res = await act(id)
        expect(res.statusCode, name).toBe(200)
        expect(await filingStatus(filing), name).toBe(expected[name])
      }

      for (const name of ["reject", "remove", "moderationRemove"]) {
        const id = await report(j.geoid)
        const filing = await insertFiling(id, j.geoid, "running", { attempts: 1 })
        const res = await actions[name]!(id)
        expect(res.statusCode, name).toBe(200)
        expect(await filingStatus(filing), name).toBe("running")
      }
    })
  })

  it("C41: an Approve verdict still only records the verdict: no filing, no job", async () => {
    const j = await jurisdiction("approve@city.test")
    const id = await report(j.geoid)
    const jobs = main.container.jobs as FakeJobs
    const before = jobs.enqueued.length
    const res = await post(main, `/v1/admin/reports/${id}/verdict`, { verdict: "approved" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(await filingsOf(id)).toEqual([])
    expect(jobs.enqueued.length).toBe(before)
  })

  describe("0211 backfill", () => {
    let text: string

    beforeAll(async () => {
      const file = (await readdir(DRIZZLE_DIR)).find((f) => f.startsWith("0211_"))
      if (file === undefined) throw new Error("no 0211 migration")
      text = await readFile(`${DRIZZLE_DIR}${file}`, "utf8")
    })

    const apply = () => h.sql.begin((tx) => tx.unsafe(text))

    async function thread(reportId: string | null): Promise<string> {
      const [row] = await h.sql<{ id: string }[]>`
        INSERT INTO mail_threads (thread_token, report_id, status)
        VALUES (${randomUUID()}, ${reportId}, 'sent')
        RETURNING id
      `
      return row!.id
    }

    async function packet(threadId: string, event: "sent" | "failed", at: Date): Promise<string> {
      const [m] = await h.sql<{ id: string }[]>`
        INSERT INTO mail_messages (thread_id, direction, to_addr, kind, created_at)
        VALUES (${threadId}, 'out', 'city@city.test', 'packet', ${at})
        RETURNING id
      `
      await h.sql`
        INSERT INTO mail_events (thread_id, message_id, type, created_at)
        VALUES (${threadId}, ${m!.id}, ${event}, ${at})
      `
      return m!.id
    }

    async function countFilings(): Promise<number> {
      const [row] = await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM report_filings`
      return row!.n
    }

    it("C31: a sent packet gets one submitted filing, a failed one or a cleanup thread none, and a re-run inserts nothing", async () => {
      const j = await jurisdiction()
      const sentAt = new Date("2026-03-01T10:00:00.000Z")
      const sent = await report(j.geoid, { status: "acknowledged" })
      const sentThread = await thread(sent)
      await packet(sentThread, "sent", sentAt)
      const failed = await report(j.geoid)
      await packet(await thread(failed), "failed", sentAt)
      await packet(await thread(null), "sent", sentAt)

      await apply()
      const filings = await filingsOf(sent)
      expect(filings).toHaveLength(1)
      expect(filings[0]).toMatchObject({
        status: "submitted",
        method: "email",
        channel: "email",
        route_category: null,
        geoid: j.geoid,
        category: "graffiti",
        mail_thread_id: sentThread,
        submitted_at: sentAt,
        ticket_text: "",
      })
      expect(await filingsOf(failed)).toEqual([])

      const total = await countFilings()
      await apply()
      expect(await countFilings()).toBe(total)
    })

    it("C44: the earliest sent packet dates the filing; a report that has a filing gets none", async () => {
      const j = await jurisdiction()
      const t1 = new Date("2026-03-02T10:00:00.000Z")
      const t2 = new Date("2026-03-03T10:00:00.000Z")
      const twice = await report(j.geoid, { status: "acknowledged" })
      const t = await thread(twice)
      await packet(t, "sent", t2)
      await packet(t, "sent", t1)

      const already = await report(j.geoid, { status: "acknowledged" })
      await insertFiling(already, j.geoid, "cancelled")
      await packet(await thread(already), "sent", t1)

      await apply()
      const filings = await filingsOf(twice)
      expect(filings).toHaveLength(1)
      expect(filings[0]).toMatchObject({ submitted_at: t1, created_at: t1 })
      expect(await filingsOf(already)).toHaveLength(1)
    })
  })

  it("C32: getOutreach counts only packets created at or after packetsSince", async () => {
    const j = await jurisdiction()
    const id = await report(j.geoid)
    const [t] = await h.sql<{ id: string }[]>`
      INSERT INTO mail_threads (thread_token, report_id, status) VALUES (${randomUUID()}, ${id}, 'sent')
      RETURNING id
    `
    const at = new Date(Date.now() - 60_000)
    const [m] = await h.sql<{ id: string }[]>`
      INSERT INTO mail_messages (thread_id, direction, to_addr, kind, created_at)
      VALUES (${t!.id}, 'out', 'city@city.test', 'packet', ${at})
      RETURNING id
    `
    await h.sql`
      INSERT INTO mail_events (thread_id, message_id, type, created_at)
      VALUES (${t!.id}, ${m!.id}, 'sent', ${at})
    `
    const repo = makeDrizzleAdminReportRepository(h.sql)
    const later = await repo.getOutreach(id, { packetsSince: new Date(at.getTime() + 1000) })
    expect(later.packetSent).toBe(false)
    expect(later.sendFailed).not.toBe(true)
    expect(later.sendInFlight).toBe(false)
    expect((await repo.getOutreach(id, { packetsSince: at })).packetSent).toBe(true)
    expect((await repo.getOutreach(id)).packetSent).toBe(true)
  })

  it("C33: loadRunPacket returns the filing's ticket and route with the first five ready images in listMedia order", async () => {
    const j = await jurisdiction()
    await h.sql`
      INSERT INTO filing_routes (geoid, category, channel, form_url, request_type_hint)
      VALUES (${j.geoid}, NULL, 'portal', 'https://myla311.lacity.gov/s/', 'Graffiti removal')
    `
    const id = await report(j.geoid, { addr: "100 Main St" })
    const base = Date.now() - 3_600_000
    async function media(kind: "image" | "video", status: string, i: number): Promise<string> {
      const key = `media/${randomUUID()}.${kind === "image" ? "jpg" : "mp4"}`
      await h.sql`
        INSERT INTO media_assets (report_id, upload_id, kind, r2_key, served_key, status, byte_size,
                                  created_at)
        VALUES (${id}, ${randomUUID()}, ${kind}, ${key}, ${status === "ready" ? key : null}, ${status},
                ${1000 + i}, ${new Date(base + i * 1000)})
      `
      return key
    }
    const images: string[] = []
    for (let i = 0; i < 3; i += 1) images.push(await media("image", "ready", i))
    await media("video", "ready", 3)
    await media("image", "validating", 4)
    for (let i = 5; i < 8; i += 1) images.push(await media("image", "ready", i))

    const [f] = await h.sql<{ id: string }[]>`
      INSERT INTO report_filings (report_id, geoid, category, route_category, channel, portal_host,
                                  form_url, status, ticket_text)
      VALUES (${id}, ${j.geoid}, 'graffiti', NULL, 'portal', 'myla311.lacity.gov',
              'https://myla311.lacity.gov/s/', 'queued', 'Tagged wall ticket')
      RETURNING id
    `
    const packet = await makeFilingsWorker(h.sql).loadRunPacket(f!.id)
    expect(packet).toEqual({
      filingId: f!.id,
      ticketText: "Tagged wall ticket",
      addr: "100 Main St",
      lat: expect.closeTo(11.005, 6),
      lng: expect.closeTo(-141.005, 6),
      category: "graffiti",
      formUrl: "https://myla311.lacity.gov/s/",
      portalHost: "myla311.lacity.gov",
      requestTypeHint: "Graffiti removal",
      photos: [0, 1, 2, 5, 6].map((i, n) => ({ servedKey: images[n], byteSize: 1000 + i })),
    })
  })
})
