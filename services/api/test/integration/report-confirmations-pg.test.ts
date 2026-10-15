/**
 * Me too (confirmReport / unconfirmReport), the pressing list and every read that carries the count,
 * through the real Fastify app on PostGIS: the container's own report, admin, claim and account wiring
 * over the real repositories and Postgres auth stores, so every case runs the SQL production runs. The
 * route rules themselves are also covered offline in test/unit/report-confirm-routes.test.ts.
 *
 * Mutations use a cookie session with its session-bound CSRF token, as the slice's test cases set up.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import { FakeMailer, type FakeJobs } from "@civfix/shared/fakes"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { clientQuery } from "../helpers/query.js"
import { makeServer } from "../../src/server.js"
import { makeContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { PgAuthStores } from "../../src/auth/pg-stores.js"
import { makeAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { generateToken, sha256Hex } from "../../src/auth/crypto.js"
import { makeDataExportService } from "../../src/services/data-export-service.js"
import { DATA_EXPORT_JOB } from "../../src/lib/queue-names.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

const OPERATOR_EMAIL = "ops@civfix.test"

interface Resident {
  userId: string
  handle: string
  cookie: string
  csrfToken: string
}

interface Region {
  bbox: { west: number; south: number; east: number; north: number }
  lat: number
  lng: number
}

describe.skipIf(!pg)("report confirmations (integration)", () => {
  let h: PgHarness
  let app: FastifyInstance
  let container: Container
  let authServices: AuthServices
  let regions = 0

  beforeAll(async () => {
    h = pg as PgHarness
    const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: h.uri, ADMIN_EMAILS: OPERATOR_EMAIL })
    container = makeContainer(env)
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
  })

  afterAll(async () => {
    await app?.close()
    await h.teardown()
  })

  /** A fresh ~1 km square no other case seeds into, inside LA. */
  function region(): Region {
    regions += 1
    const lng = -118.6 + regions * 0.02
    const lat = 34.05
    return {
      bbox: { west: lng - 0.005, south: lat - 0.005, east: lng + 0.005, north: lat + 0.005 },
      lat,
      lng,
    }
  }

  async function resident(opts: { email?: string; role?: string } = {}): Promise<Resident> {
    const handle = testHandle()
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, email, email_verified, role)
      VALUES (${`Resident ${handle}`}, ${handle}, ${opts.email ?? null}, ${opts.email !== undefined},
              ${opts.role ?? "citizen"})
      RETURNING id
    `
    const userId = u!.id
    const token = await authServices.sessions.createSession(userId, [opts.role ?? "citizen"])
    const csrfToken = await container.csrf.tokenForSession(token)
    return { userId, handle, cookie: `civfix_session=${token}`, csrfToken }
  }

  async function report(
    at: Region,
    opts: {
      reporter?: Resident | null
      status?: string
      visibility?: string
      deleted?: boolean
      title?: string
      createdAt?: Date
      claimCodeHash?: string
      confirmCount?: number
    } = {},
  ): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        reporter_user_id, idempotency_key, geom, geom_source, category, type, title, status, visibility,
        h3_cell, jurisdiction_geoid, deleted_at, created_at, claim_code_hash, confirm_count
      ) VALUES (
        ${opts.reporter === null ? null : (opts.reporter?.userId ?? null)},
        ${randomUUID()},
        ST_SetSRID(ST_MakePoint(${at.lng}, ${at.lat}), 4326),
        'device', 'trash', 'dump', ${opts.title ?? "Overflowing bin"},
        ${opts.status ?? "published"}, ${opts.visibility ?? "public"}, 'h0', ${LA_CITY.geoid},
        ${opts.deleted ? new Date() : null}, ${opts.createdAt ?? new Date()},
        ${opts.claimCodeHash ?? null}, ${opts.confirmCount ?? 0}
      )
      RETURNING id
    `
    return row!.id
  }

  /** Real rows behind a seeded count, so the count and the rows agree as the toggle keeps them. */
  async function seedConfirmations(reportId: string, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      const voter = await resident()
      await h.sql`INSERT INTO report_confirmations (report_id, user_id) VALUES (${reportId}, ${voter.userId})`
    }
    await h.sql`UPDATE reports SET confirm_count = ${n} WHERE id = ${reportId}`
  }

  let operatorSession: Promise<Resident> | undefined
  function operator(): Promise<Resident> {
    operatorSession ??= resident({ email: OPERATOR_EMAIL, role: "operator" })
    return operatorSession
  }

  function headers(s: Resident): Record<string, string> {
    return { cookie: s.cookie, "x-csrf-token": s.csrfToken }
  }

  function confirm(s: Resident, id: string): Promise<LightMyRequestResponse> {
    return app.inject({ method: "POST", url: `/v1/reports/${id}/confirm`, headers: headers(s) })
  }

  function unconfirm(s: Resident, id: string): Promise<LightMyRequestResponse> {
    return app.inject({ method: "DELETE", url: `/v1/reports/${id}/confirm`, headers: headers(s) })
  }

  function getReport(id: string, s?: Resident): Promise<LightMyRequestResponse> {
    return app.inject({
      method: "GET",
      url: `/v1/reports/${id}`,
      ...(s ? { headers: { cookie: s.cookie } } : {}),
    })
  }

  function pressing(at: Region, s?: Resident): Promise<LightMyRequestResponse> {
    return app.inject({
      method: "GET",
      url: `/v1/reports/pressing${clientQuery({ bbox: at.bbox })}`,
      ...(s ? { headers: { cookie: s.cookie } } : {}),
    })
  }

  async function stored(reportId: string): Promise<{ count: number; rows: string[] }> {
    const [r] = await h.sql<{ confirm_count: number }[]>`
      SELECT confirm_count FROM reports WHERE id = ${reportId}
    `
    const rows = await h.sql<{ user_id: string }[]>`
      SELECT user_id FROM report_confirmations WHERE report_id = ${reportId} ORDER BY created_at, user_id
    `
    return { count: r?.confirm_count ?? 0, rows: rows.map((x) => x.user_id) }
  }

  function errorBody(res: LightMyRequestResponse): Record<string, unknown> {
    const { requestId: _requestId, ...rest } = res.json<Record<string, unknown>>()
    return rest
  }

  describe("confirm and remove", () => {
    it("T1, T2, T3: confirm, a repeat no-op, a second resident", async () => {
      const at = region()
      const [a, b, c] = [await resident(), await resident(), await resident()]
      const r = await report(at, { reporter: a })

      const first = await confirm(b, r)
      expect(first.statusCode).toBe(200)
      expect(first.json()).toEqual({ confirmCount: 1, confirmedByMe: true })
      expect(await stored(r)).toEqual({ count: 1, rows: [b.userId] })

      const again = await confirm(b, r)
      expect(again.statusCode).toBe(200)
      expect(again.json()).toEqual({ confirmCount: 1, confirmedByMe: true })
      expect(await stored(r)).toEqual({ count: 1, rows: [b.userId] })

      const third = await confirm(c, r)
      expect(third.json()).toEqual({ confirmCount: 2, confirmedByMe: true })
    })

    it("T4: acknowledged and in_progress reports take confirmations", async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      for (const status of ["acknowledged", "in_progress"]) {
        const res = await confirm(b, await report(at, { reporter: a, status }))
        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ confirmCount: 1, confirmedByMe: true })
      }
    })

    it("T5, T6, T7: remove, a repeat no-op, removing a missing one", async () => {
      const at = region()
      const [a, b, c] = [await resident(), await resident(), await resident()]
      const r = await report(at, { reporter: a })
      await confirm(b, r)
      await confirm(c, r)

      const removed = await unconfirm(b, r)
      expect(removed.statusCode).toBe(200)
      expect(removed.json()).toEqual({ confirmCount: 1, confirmedByMe: false })
      expect(await stored(r)).toEqual({ count: 1, rows: [c.userId] })

      const again = await unconfirm(b, r)
      expect(again.json()).toEqual({ confirmCount: 1, confirmedByMe: false })
      expect((await stored(r)).count).toBe(1)

      const untouched = await report(at, { reporter: a })
      const none = await unconfirm(b, untouched)
      expect(none.statusCode).toBe(200)
      expect(none.json()).toEqual({ confirmCount: 0, confirmedByMe: false })
      expect((await stored(untouched)).count).toBe(0)
    })

    it("T8, T9: a resolved report takes a removal but not a confirmation", async () => {
      const at = region()
      const [a, b, c] = [await resident(), await resident(), await resident()]
      const r = await report(at, { reporter: a })
      await confirm(b, r)
      await h.sql`UPDATE reports SET status = 'resolved' WHERE id = ${r}`

      const refused = await confirm(c, r)
      expect(refused.statusCode).toBe(409)
      expect(refused.json().code).toBe("CONFLICT")
      expect(await stored(r)).toEqual({ count: 1, rows: [b.userId] })

      const removed = await unconfirm(b, r)
      expect(removed.statusCode).toBe(200)
      expect(removed.json()).toEqual({ confirmCount: 0, confirmedByMe: false })
      expect(await stored(r)).toEqual({ count: 0, rows: [] })
    })

    it("T10, T11: the reporter is FORBIDDEN on an open and on a resolved report", async () => {
      const at = region()
      const a = await resident()
      for (const status of ["published", "resolved"]) {
        const r = await report(at, { reporter: a, status })
        for (const send of [confirm, unconfirm]) {
          const res = await send(a, r)
          expect(res.statusCode).toBe(403)
          expect(res.json().code).toBe("FORBIDDEN")
        }
        expect(await stored(r)).toEqual({ count: 0, rows: [] })
      }
    })

    it("T12: what a non-owner cannot see is NOT_FOUND like an unknown id, for B and for A", async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const targets = [
        randomUUID(),
        await report(at, { reporter: a, visibility: "hidden" }),
        await report(at, { reporter: a, status: "held" }),
        await report(at, { reporter: a, status: "submitted" }),
        await report(at, { reporter: a, status: "rejected" }),
        await report(at, { reporter: a, deleted: true }),
      ]
      const unknown = errorBody(await confirm(b, targets[0]!))
      for (const caller of [b, a]) {
        for (const id of targets) {
          for (const send of [confirm, unconfirm]) {
            const res = await send(caller, id)
            expect(res.statusCode).toBe(404)
            expect(errorBody(res)).toEqual(unknown)
          }
          expect(await stored(id)).toEqual({ count: 0, rows: [] })
        }
      }
    })
  })

  describe("reads", () => {
    it("T17: getReport sends the count and confirmedByMe for the signed-in caller", async () => {
      const at = region()
      const [a, b, c] = [await resident(), await resident(), await resident()]
      const r = await report(at, { reporter: a })
      const referenceCode = `DMP-6-${String(regions).padStart(6, "0")}`
      await h.sql`UPDATE reports SET reference_code = ${referenceCode} WHERE id = ${r}`
      await confirm(b, r)
      await confirm(c, r)
      await unconfirm(c, r)

      const seen = async (s: Resident | undefined, id = r) => {
        const res = await getReport(id, s)
        expect(res.statusCode).toBe(200)
        const { confirmCount, confirmedByMe } = res.json()
        return { confirmCount, confirmedByMe }
      }
      expect(await seen(b)).toEqual({ confirmCount: 1, confirmedByMe: true })
      expect(await seen(c)).toEqual({ confirmCount: 1, confirmedByMe: false })
      expect(await seen(a)).toEqual({ confirmCount: 1, confirmedByMe: false })
      expect(await seen(undefined)).toEqual({ confirmCount: 1, confirmedByMe: false })
      expect(await seen(b, referenceCode)).toEqual({ confirmCount: 1, confirmedByMe: true })
    })

    it("T18: createReport and its replay send 0 / false", async () => {
      const a = await resident()
      const payload = {
        idempotencyKey: randomUUID(),
        category: "trash",
        type: "dump",
        lat: 34.05,
        lng: -118.25,
        geomSource: "device",
        mediaUploadIds: [],
      }
      for (let i = 0; i < 2; i += 1) {
        const res = await app.inject({
          method: "POST",
          url: "/v1/reports",
          headers: headers(a),
          payload,
        })
        expect(res.statusCode).toBe(201)
        expect(res.json().confirmCount).toBe(0)
        expect(res.json().confirmedByMe).toBe(false)
      }
    })

    it("T19, T20: listMyReports and resolveReport send the count with confirmedByMe false", async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const r = await report(at, { reporter: a })
      await confirm(b, r)

      const list = await app.inject({
        method: "GET",
        url: "/v1/reports",
        headers: { cookie: a.cookie },
      })
      const item = list.json().items.find((i: { id: string }) => i.id === r)
      expect(item.confirmCount).toBe(1)
      expect(item.confirmedByMe).toBe(false)

      const resolved = await app.inject({
        method: "POST",
        url: `/v1/reports/${r}/resolve`,
        headers: headers(a),
        payload: { resolved: true },
      })
      expect(resolved.statusCode).toBe(200)
      expect(resolved.json().confirmCount).toBe(1)
      expect(resolved.json().confirmedByMe).toBe(false)
    })

    it("T21, T22: map pins and search items carry confirmCount", async () => {
      const at = region()
      const [a, b, c] = [await resident(), await resident(), await resident()]
      const title = `Leaning pole ${randomUUID()}`
      const r = await report(at, { reporter: a, title })
      const s = await report(at, { reporter: a })
      await confirm(b, r)
      await confirm(c, r)

      const map = await app.inject({
        method: "GET",
        url: `/v1/map/reports${clientQuery({ bbox: at.bbox, zoom: 18 })}`,
      })
      expect(map.statusCode).toBe(200)
      const pins = map.json().pins as { id: string; confirmCount: number }[]
      expect(pins.find((p) => p.id === r)?.confirmCount).toBe(2)
      expect(pins.find((p) => p.id === s)?.confirmCount).toBe(0)

      const search = await app.inject({
        method: "GET",
        url: `/v1/reports/search${clientQuery({ q: title })}`,
      })
      expect(search.statusCode).toBe(200)
      expect(search.json().items.find((i: { id: string }) => i.id === r)?.confirmCount).toBe(2)
    })
  })

  describe("pressing", () => {
    it("T23, T24, T27, T30: order, cache header, the same body for everyone, thumbnails", async () => {
      const empty = region()
      const none = await pressing(empty)
      expect(none.statusCode).toBe(200)
      expect(none.json()).toEqual({ items: [] })
      expect(none.headers["cache-control"]).toBe("public, max-age=60")

      const at = region()
      const a = await resident()
      const p1 = await report(at, { reporter: a, createdAt: new Date("2026-02-01T00:00:00Z") })
      const p2 = await report(at, { reporter: a, createdAt: new Date("2026-02-02T00:00:00Z") })
      const p3 = await report(at, { reporter: a })
      const p4 = await report(at, { reporter: a })
      await seedConfirmations(p1, 3)
      await seedConfirmations(p2, 3)
      await seedConfirmations(p3, 5)
      await seedConfirmations(p4, 1)
      await h.sql`
        INSERT INTO media_assets (report_id, upload_id, kind, r2_key, served_key, status)
        VALUES (${p1}, gen_random_uuid(), 'image', 'k/p1.jpg', 'k/p1.serve.jpg', 'ready')
      `

      const guest = await pressing(at)
      expect(guest.statusCode).toBe(200)
      const items = guest.json().items as {
        id: string
        confirmCount: number
        thumbUrl: string | null
      }[]
      expect(items.map((i) => i.id)).toEqual([p3, p2, p1, p4])
      expect(items.map((i) => i.confirmCount)).toEqual([5, 3, 3, 1])
      expect(items.find((i) => i.id === p1)?.thumbUrl).toEqual(expect.any(String))
      expect(items.find((i) => i.id === p4)?.thumbUrl).toBeNull()

      const signedIn = await pressing(at, await resident())
      expect(signedIn.json()).toEqual(guest.json())
    })

    it("T25: only open public reports in the bbox with a count of at least 1", async () => {
      const at = region()
      const elsewhere = region()
      const a = await resident()
      for (const opts of [
        { status: "resolved" },
        { visibility: "hidden" },
        { status: "held" },
        { status: "submitted" },
        { status: "rejected" },
        { deleted: true },
      ]) {
        await seedConfirmations(await report(at, { reporter: a, ...opts }), 2)
      }
      await report(at, { reporter: a })
      await seedConfirmations(await report(elsewhere, { reporter: a }), 1)
      const k = await report(at, { reporter: a })
      await seedConfirmations(k, 1)

      const res = await pressing(at)
      expect(res.json().items.map((i: { id: string }) => i.id)).toEqual([k])
    })

    it("T26: at most 20 items, the most confirmed", async () => {
      const at = region()
      const a = await resident()
      for (let n = 1; n <= 25; n += 1) await report(at, { reporter: a, confirmCount: n })
      const res = await pressing(at)
      expect(res.statusCode).toBe(200)
      expect(res.json().items.map((i: { confirmCount: number }) => i.confirmCount)).toEqual(
        Array.from({ length: 20 }, (_, i) => 25 - i),
      )
    })
  })

  describe("admin", () => {
    it("T31, T32: admin's confirmations and the forward email come from the count", async () => {
      const at = region()
      const [a, b, c] = [await resident(), await resident(), await resident()]
      const op = await operator()
      const r = await report(at, { reporter: a, title: `Confirmed ${randomUUID()}` })
      const s = await report(at, { reporter: a, title: `Unconfirmed ${randomUUID()}` })
      await confirm(b, r)
      await confirm(c, r)

      const asOperator = { cookie: op.cookie, "x-csrf-token": op.csrfToken }
      const list = await app.inject({
        method: "GET",
        url: "/v1/admin/reports",
        headers: asOperator,
      })
      expect(list.statusCode).toBe(200)
      const rows = list.json().items as { id: string; confirmations: number }[]
      expect(rows.find((x) => x.id === r)?.confirmations).toBe(2)
      expect(rows.find((x) => x.id === s)?.confirmations).toBe(0)
      for (const [id, expected] of [
        [r, 2],
        [s, 0],
      ] as const) {
        const detail = await app.inject({
          method: "GET",
          url: `/v1/admin/reports/${id}`,
          headers: asOperator,
        })
        expect(detail.statusCode).toBe(200)
        expect(detail.json().confirmations).toBe(expected)
      }

      await h.sql`
        INSERT INTO jurisdiction_contacts (geoid, category, email)
        VALUES (${LA_CITY.geoid}, NULL, 'forward@lacity.test')
      `
      await h.sql`
        INSERT INTO forward_template_settings (id, body_template)
        VALUES (1, 'Neighbors who confirmed it: {confirmations}.')
        ON CONFLICT (id) DO UPDATE SET body_template = EXCLUDED.body_template
      `
      const routed = await app.inject({
        method: "POST",
        url: `/v1/admin/reports/${r}/route`,
        headers: asOperator,
        payload: {},
      })
      expect(routed.statusCode).toBe(200)
      const sent = (container.mailer as FakeMailer).lastOutbound()
      expect(sent?.text).toContain("Neighbors who confirmed it: 2.")
    })
  })

  describe("claim", () => {
    async function anonymousReport(at: Region): Promise<{ id: string; code: string }> {
      const code = generateToken()
      const id = await report(at, { reporter: null, claimCodeHash: await sha256Hex(code) })
      return { id, code }
    }

    function claim(s: Resident, code: string): Promise<LightMyRequestResponse> {
      return app.inject({
        method: "POST",
        url: "/v1/claim/report",
        headers: headers(s),
        payload: { claimCode: code },
      })
    }

    it("T34: claiming removes the claimant's own confirmation in the claim's transaction", async () => {
      const at = region()
      const [b, c] = [await resident(), await resident()]
      const r = await anonymousReport(at)
      await confirm(b, r.id)
      await confirm(c, r.id)

      const res = await claim(b, r.code)
      expect(res.statusCode).toBe(200)
      expect(res.json().report.confirmCount).toBe(1)
      expect(res.json().report.confirmedByMe).toBe(false)
      expect(await stored(r.id)).toEqual({ count: 1, rows: [c.userId] })

      const after = await confirm(b, r.id)
      expect(after.statusCode).toBe(403)
      expect(after.json().code).toBe("FORBIDDEN")
    })

    it("T35: a claimant with no confirmation leaves the count alone", async () => {
      const at = region()
      const [b, c] = [await resident(), await resident()]
      const r = await anonymousReport(at)
      await confirm(c, r.id)

      const res = await claim(b, r.code)
      expect(res.statusCode).toBe(200)
      expect(res.json().report.confirmCount).toBe(1)
      expect(await stored(r.id)).toEqual({ count: 1, rows: [c.userId] })
    })
  })

  describe("account data", () => {
    it("T36: the data export lists the user's own confirmations, newest first", async () => {
      const at = region()
      const a = await resident()
      const b = await resident({ email: `b-${randomUUID()}@example.com` })
      const c = await resident()
      const r1 = await report(at, { reporter: a })
      const r2 = await report(at, { reporter: a })
      await confirm(b, r1)
      await h.sql`
        UPDATE report_confirmations SET created_at = now() - interval '1 minute'
        WHERE report_id = ${r1} AND user_id = ${b.userId}
      `
      await confirm(b, r2)
      await confirm(c, r1)

      const requested = await app.inject({
        method: "POST",
        url: "/v1/me/data-export",
        headers: headers(b),
      })
      expect(requested.statusCode).toBe(200)
      const job = (container.jobs as unknown as FakeJobs)
        .jobsFor(DATA_EXPORT_JOB)
        .find((j) => (j.data as { userId: string }).userId === b.userId)
      expect(job).toBeDefined()

      const mailer = new FakeMailer()
      await makeDataExportService({
        sql: h.sql,
        mailer,
        users: authServices.users,
        fromNoReply: "no-reply@civfix.test",
        supportEmail: "support@civfix.test",
      }).exportData(b.userId)
      const attachment = mailer.lastOutbound()!.attachments![0]!
      const parsed = JSON.parse(new TextDecoder().decode(attachment.content)) as {
        reportConfirmations: Record<string, unknown>[]
      }
      expect(parsed.reportConfirmations.map((x) => x.reportId)).toEqual([r2, r1])
      for (const row of parsed.reportConfirmations) {
        expect(Object.keys(row).sort()).toEqual(["createdAt", "reportId"])
        expect(new Date(row.createdAt as string).toISOString()).toBe(row.createdAt)
      }
    })

    it("T37: a deleted account's confirmation is kept and still counts", async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const r = await report(at, { reporter: a })
      await confirm(b, r)

      const deleted = await app.inject({
        method: "DELETE",
        url: "/v1/me",
        headers: headers(b),
        payload: { emailOtp: "000000" },
      })
      expect(deleted.statusCode).toBe(200)
      expect(await stored(r)).toEqual({ count: 1, rows: [b.userId] })
      expect((await getReport(r)).json().confirmCount).toBe(1)
    })
  })

  describe("privacy", () => {
    it("T38: admin reads never name who confirmed", async () => {
      const at = region()
      const [a, b, c] = [await resident(), await resident(), await resident()]
      const op = await operator()
      const r = await report(at, { reporter: a })
      await confirm(b, r)
      await confirm(c, r)

      const asOperator = { cookie: op.cookie }
      const bodies = [
        (await app.inject({ method: "GET", url: "/v1/admin/reports", headers: asOperator })).body,
        (await app.inject({ method: "GET", url: `/v1/admin/reports/${r}`, headers: asOperator }))
          .body,
        (await getReport(r, a)).body,
        (await getReport(r)).body,
        (await pressing(at)).body,
      ]
      for (const body of bodies) {
        for (const secret of [b.userId, b.handle, c.userId, c.handle]) {
          expect(body).not.toContain(secret)
        }
      }
    })
  })

  describe("concurrency", () => {
    it("T39: interleaved confirms and removals keep the count equal to the rows", async () => {
      const at = region()
      const a = await resident()
      const r = await report(at, { reporter: a })
      const voters = await Promise.all(Array.from({ length: 10 }, () => resident()))

      const responses = await Promise.all(
        voters.flatMap((v) =>
          Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? confirm(v, r) : unconfirm(v, r))),
        ),
      )
      for (const res of responses) {
        expect(res.statusCode).toBe(200)
        expect(res.json().confirmCount).toBeGreaterThanOrEqual(0)
      }
      const [counted] = await h.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM report_confirmations WHERE report_id = ${r}
      `
      expect((await stored(r)).count).toBe(counted!.n)
    })

    it("T40: ten concurrent confirms by one resident write one row", async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const r = await report(at, { reporter: a })
      const responses = await Promise.all(Array.from({ length: 10 }, () => confirm(b, r)))
      for (const res of responses) {
        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ confirmCount: 1, confirmedByMe: true })
      }
      expect(await stored(r)).toEqual({ count: 1, rows: [b.userId] })
    })
  })
})
