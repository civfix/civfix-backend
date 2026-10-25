/**
 * "This is fixed" votes (markReportFixed / unmarkReportFixed), the move between a fixed vote and an
 * "I see this too" confirmation, and the pressing ranking by recent votes (DECISIONS §61), through the real
 * Fastify app on PostGIS: the container's own report, admin, claim and account wiring over the real
 * repositories, so every case runs the SQL production runs. The route guards (session, CSRF, rate limit)
 * are covered offline in test/unit/report-fixed-votes-routes.test.ts.
 *
 * Setup, as in the slice's test cases: resident A filed report R (published); B and C are other residents.
 * Mutations use a cookie session with its session-bound CSRF token.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import { FakeMailer, type FakeJobs } from "@civfix/seams"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { createPressingIndex, explainPressingAlone } from "../helpers/pressing-index.js"
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
import { PRESSING_INDEX } from "../../src/services/report-repository.drizzle.js"

const pg = await withPg()

const OPERATOR_EMAIL = "ops-fixed@civfix.test"

type Kind = "seen" | "fixed"

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

interface VoteBody {
  confirmCount: number
  confirmedByMe: boolean
  fixedCount: number
  fixedByMe: boolean
}

interface StoredVote {
  user_id: string
  kind: Kind
  created_at: Date
}

describe.skipIf(!pg)("report fixed votes (integration)", () => {
  let h: PgHarness
  let app: FastifyInstance
  let container: Container
  let authServices: AuthServices
  let regions = 0
  const voterPool: string[] = []

  beforeAll(async () => {
    h = pg as PgHarness
    await createPressingIndex(h.sql)
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
    const lat = 34.15
    return {
      bbox: { west: lng - 0.005, south: lat - 0.005, east: lng + 0.005, north: lat + 0.005 },
      lat,
      lng,
    }
  }

  async function resident(
    opts: { email?: string; role?: "citizen" | "operator" } = {},
  ): Promise<Resident> {
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

  /** Accounts that only ever vote through seeded rows; one account votes at most once per report. */
  async function voters(n: number): Promise<string[]> {
    while (voterPool.length < n) {
      const handle = testHandle()
      const [u] = await h.sql<{ id: string }[]>`
        INSERT INTO users (display_name, handle) VALUES (${`Voter ${handle}`}, ${handle}) RETURNING id
      `
      voterPool.push(u!.id)
    }
    return voterPool.slice(0, n)
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
    } = {},
  ): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        reporter_user_id, idempotency_key, geom, geom_source, category, type, title, status, visibility,
        h3_cell, jurisdiction_geoid, deleted_at, created_at, claim_code_hash
      ) VALUES (
        ${opts.reporter === null ? null : (opts.reporter?.userId ?? null)},
        ${randomUUID()},
        ST_SetSRID(ST_MakePoint(${at.lng}, ${at.lat}), 4326),
        'device', 'trash', 'dump', ${opts.title ?? "Overflowing bin"},
        ${opts.status ?? "published"}, ${opts.visibility ?? "public"}, 'h0', ${LA_CITY.geoid},
        ${opts.deleted ? new Date() : null}, ${opts.createdAt ?? new Date()},
        ${opts.claimCodeHash ?? null}
      )
      RETURNING id
    `
    return row!.id
  }

  /**
   * Real rows behind the counts, oldest first, a second apart and an hour back, with the counts the vote
   * transactions would have left.
   */
  async function seedVotes(reportId: string, kinds: Kind[]): Promise<void> {
    const people = await voters(kinds.length)
    const base = Date.now() - 3_600_000
    const rows = kinds.map((kind, i) => ({
      report_id: reportId,
      user_id: people[i]!,
      kind,
      created_at: new Date(base + i * 1000),
    }))
    if (rows.length > 0) await h.sql`INSERT INTO report_confirmations ${h.sql(rows)}`
    const seen = kinds.filter((k) => k === "seen").length
    await h.sql`
      UPDATE reports SET confirm_count = ${seen}, fixed_count = ${kinds.length - seen}
      WHERE id = ${reportId}
    `
  }

  const seen = (n: number): Kind[] => Array.from({ length: n }, () => "seen" as const)

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

  function markFixed(s: Resident, id: string): Promise<LightMyRequestResponse> {
    return app.inject({ method: "POST", url: `/v1/reports/${id}/fixed`, headers: headers(s) })
  }

  function unmarkFixed(s: Resident, id: string): Promise<LightMyRequestResponse> {
    return app.inject({ method: "DELETE", url: `/v1/reports/${id}/fixed`, headers: headers(s) })
  }

  function getReport(id: string, s?: Resident): Promise<LightMyRequestResponse> {
    return app.inject({
      method: "GET",
      url: `/v1/reports/${id}`,
      ...(s ? { headers: { cookie: s.cookie } } : {}),
    })
  }

  function pressing(at: Region): Promise<LightMyRequestResponse> {
    return app.inject({
      method: "GET",
      url: `/v1/reports/pressing${clientQuery({ bbox: at.bbox })}`,
    })
  }

  async function pressingIds(at: Region): Promise<string[]> {
    const res = await pressing(at)
    expect(res.statusCode).toBe(200)
    return (res.json().items as { id: string }[]).map((i) => i.id)
  }

  async function stored(
    reportId: string,
  ): Promise<{ confirmCount: number; fixedCount: number; rows: StoredVote[] }> {
    const [r] = await h.sql<{ confirm_count: number; fixed_count: number }[]>`
      SELECT confirm_count, fixed_count FROM reports WHERE id = ${reportId}
    `
    const rows = await h.sql<StoredVote[]>`
      SELECT user_id, kind, created_at FROM report_confirmations
      WHERE report_id = ${reportId}
      ORDER BY created_at, user_id
    `
    return {
      confirmCount: r?.confirm_count ?? 0,
      fixedCount: r?.fixed_count ?? 0,
      rows: [...rows],
    }
  }

  async function voteOf(reportId: string, s: Resident): Promise<StoredVote | undefined> {
    return (await stored(reportId)).rows.find((row) => row.user_id === s.userId)
  }

  function body(res: LightMyRequestResponse): VoteBody {
    return res.json<VoteBody>()
  }

  function errorBody(res: LightMyRequestResponse): Record<string, unknown> {
    const { requestId: _requestId, ...rest } = res.json<Record<string, unknown>>()
    return rest
  }

  async function backdate(reportId: string, s: Resident): Promise<Date> {
    const [row] = await h.sql<{ created_at: Date }[]>`
      UPDATE report_confirmations SET created_at = now() - interval '1 minute'
      WHERE report_id = ${reportId} AND user_id = ${s.userId}
      RETURNING created_at
    `
    return row!.created_at
  }

  const NONE: VoteBody = { confirmCount: 0, confirmedByMe: false, fixedCount: 0, fixedByMe: false }

  describe("marking and removing a fixed vote", () => {
    it("T1: B, no vote on R, marks it fixed", async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const r = await report(at, { reporter: a })
      const res = await markFixed(b, r)
      expect(res.statusCode).toBe(200)
      expect(body(res)).toEqual({
        confirmCount: 0,
        confirmedByMe: false,
        fixedCount: 1,
        fixedByMe: true,
      })
    })

    it("T2: B repeats the mark: the same body, R's counts unchanged", async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const r = await report(at, { reporter: a })
      const first = await markFixed(b, r)
      const before = await stored(r)
      const again = await markFixed(b, r)
      expect(again.statusCode).toBe(200)
      expect(body(again)).toEqual(body(first))
      expect(await stored(r)).toEqual(before)
      expect(before).toMatchObject({ confirmCount: 0, fixedCount: 1 })
    })

    it('T3: B\'s "I see this too" moves to a fixed vote with a new created_at', async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const r = await report(at, { reporter: a })
      expect((await confirm(b, r)).statusCode).toBe(200)
      const confirmedAt = await backdate(r, b)
      expect(await stored(r)).toMatchObject({ confirmCount: 1, fixedCount: 0 })

      const res = await markFixed(b, r)
      expect(res.statusCode).toBe(200)
      expect(body(res)).toEqual({
        confirmCount: 0,
        confirmedByMe: false,
        fixedCount: 1,
        fixedByMe: true,
      })
      const row = await voteOf(r, b)
      expect(row?.kind).toBe("fixed")
      expect(row!.created_at.getTime()).toBeGreaterThan(confirmedAt.getTime())
    })

    it('T4: B\'s fixed vote moves to "I see this too" through confirm', async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const r = await report(at, { reporter: a })
      await markFixed(b, r)
      const res = await confirm(b, r)
      expect(res.statusCode).toBe(200)
      expect(body(res)).toEqual({
        confirmCount: 1,
        confirmedByMe: true,
        fixedCount: 0,
        fixedByMe: false,
      })
    })

    it("T5: B removes the fixed vote, then repeats", async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const r = await report(at, { reporter: a })
      await markFixed(b, r)
      const removed = await unmarkFixed(b, r)
      expect(removed.statusCode).toBe(200)
      expect(body(removed)).toEqual(NONE)
      const again = await unmarkFixed(b, r)
      expect(again.statusCode).toBe(200)
      expect(body(again)).toEqual(NONE)
    })

    it('T6: removing a fixed vote leaves B\'s "I see this too" in place', async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const r = await report(at, { reporter: a })
      await confirm(b, r)
      const res = await unmarkFixed(b, r)
      expect(res.statusCode).toBe(200)
      expect(body(res)).toEqual({
        confirmCount: 1,
        confirmedByMe: true,
        fixedCount: 0,
        fixedByMe: false,
      })
      expect((await voteOf(r, b))?.kind).toBe("seen")
    })

    it('T7: removing an "I see this too" leaves B\'s fixed vote in place', async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const r = await report(at, { reporter: a })
      await markFixed(b, r)
      const res = await unconfirm(b, r)
      expect(res.statusCode).toBe(200)
      expect(body(res)).toEqual({
        confirmCount: 0,
        confirmedByMe: false,
        fixedCount: 1,
        fixedByMe: true,
      })
      expect((await voteOf(r, b))?.kind).toBe("fixed")
    })
  })

  describe("errors", () => {
    it("T8: A marking own R fixed is FORBIDDEN", async () => {
      const at = region()
      const a = await resident()
      const r = await report(at, { reporter: a })
      const res = await markFixed(a, r)
      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe("FORBIDDEN")
    })

    it("T9: a resolved R refuses B's mark but takes B's removal", async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const r = await report(at, { reporter: a })
      await markFixed(b, r)
      await h.sql`UPDATE reports SET status = 'resolved' WHERE id = ${r}`

      const refused = await markFixed(b, r)
      expect(refused.statusCode).toBe(409)
      expect(refused.json().code).toBe("CONFLICT")

      const removed = await unmarkFixed(b, r)
      expect(removed.statusCode).toBe(200)
      expect(await voteOf(r, b)).toBeUndefined()
      expect(await stored(r)).toMatchObject({ confirmCount: 0, fixedCount: 0 })
    })

    it("T10: a hidden R is NOT_FOUND like an unknown id, for A and for B, both methods", async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const hidden = await report(at, { reporter: a, visibility: "hidden" })
      const unknownId = randomUUID()
      const unknown = errorBody(await markFixed(b, unknownId))
      for (const caller of [a, b]) {
        for (const id of [hidden, unknownId]) {
          for (const send of [markFixed, unmarkFixed]) {
            const res = await send(caller, id)
            expect(res.statusCode, `${send.name} ${id}`).toBe(404)
            expect(res.json().code).toBe("NOT_FOUND")
            expect(errorBody(res)).toEqual(unknown)
          }
        }
      }
      expect(await stored(hidden)).toEqual({ confirmCount: 0, fixedCount: 0, rows: [] })
    })

    it("T28: held, deleted, submitted and rejected reports are NOT_FOUND like an unknown id, for A and B", async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const targets = [
        await report(at, { reporter: a, status: "held" }),
        await report(at, { reporter: a, deleted: true }),
        await report(at, { reporter: a, status: "submitted" }),
        await report(at, { reporter: a, status: "rejected" }),
      ]
      const unknown = errorBody(await markFixed(b, randomUUID()))
      for (const caller of [a, b]) {
        for (const id of targets) {
          for (const send of [markFixed, unmarkFixed]) {
            const res = await send(caller, id)
            expect(res.statusCode, `${send.name} ${id}`).toBe(404)
            expect(errorBody(res)).toEqual(unknown)
          }
          expect(await stored(id)).toEqual({ confirmCount: 0, fixedCount: 0, rows: [] })
        }
      }
    })

    it("T29: A removing a fixed vote on own R is FORBIDDEN", async () => {
      const at = region()
      const a = await resident()
      const r = await report(at, { reporter: a })
      const res = await unmarkFixed(a, r)
      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe("FORBIDDEN")
    })

    it('T30: a resolved R refuses moving B\'s "I see this too" to fixed and leaves the row alone', async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const r = await report(at, { reporter: a })
      await confirm(b, r)
      const confirmedAt = await backdate(r, b)
      await h.sql`UPDATE reports SET status = 'resolved' WHERE id = ${r}`

      const res = await markFixed(b, r)
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe("CONFLICT")
      const row = await voteOf(r, b)
      expect(row?.kind).toBe("seen")
      expect(row?.created_at.getTime()).toBe(confirmedAt.getTime())
      expect(await stored(r)).toMatchObject({ confirmCount: 1, fixedCount: 0 })
    })
  })

  describe("concurrency", () => {
    it("T14: interleaved concurrent calls of all four keep both counts equal to the rows", async () => {
      const at = region()
      const [a, b, c] = [await resident(), await resident(), await resident()]
      const r = await report(at, { reporter: a })
      const calls = [confirm, markFixed, unconfirm, unmarkFixed]

      const responses = await Promise.all(
        [b, c].flatMap((v) => Array.from({ length: 20 }, (_, i) => calls[i % calls.length]!(v, r))),
      )
      for (const res of responses) expect(res.statusCode).toBe(200)

      const { confirmCount, fixedCount, rows } = await stored(r)
      expect(confirmCount).toBe(rows.filter((x) => x.kind === "seen").length)
      expect(fixedCount).toBe(rows.filter((x) => x.kind === "fixed").length)
      for (const v of [b, c]) {
        expect(rows.filter((x) => x.user_id === v.userId).length).toBeLessThanOrEqual(1)
      }
    })
  })

  describe("reads", () => {
    it("T15: getReport sends fixedCount, and fixedByMe for the signed-in voter only", async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const r = await report(at, { reporter: a })
      await markFixed(b, r)

      const seenBy = async (s?: Resident) => {
        const res = await getReport(r, s)
        expect(res.statusCode).toBe(200)
        const { fixedCount, fixedByMe, confirmedByMe } = res.json()
        return { fixedCount, fixedByMe, confirmedByMe }
      }
      expect(await seenBy(b)).toEqual({ fixedCount: 1, fixedByMe: true, confirmedByMe: false })
      expect(await seenBy()).toMatchObject({ fixedCount: 1, fixedByMe: false })
      expect(await seenBy(a)).toMatchObject({ fixedCount: 1, fixedByMe: false })
    })

    it("T16: R's map pin carries both counts", async () => {
      const at = region()
      const [a, b, c, d] = [await resident(), await resident(), await resident(), await resident()]
      const r = await report(at, { reporter: a })
      await confirm(b, r)
      await confirm(c, r)
      await markFixed(d, r)

      const res = await app.inject({
        method: "GET",
        url: `/v1/map/reports${clientQuery({ bbox: at.bbox, zoom: 18 })}`,
      })
      expect(res.statusCode).toBe(200)
      const pin = (res.json().pins as { id: string }[]).find((p) => p.id === r)
      expect(pin).toMatchObject({ confirmCount: 2, fixedCount: 1 })
    })

    it("T33: R's search pin and pressing pin carry both counts", async () => {
      const at = region()
      const [a, b, c, d] = [await resident(), await resident(), await resident(), await resident()]
      const title = `Tilted sign ${randomUUID()}`
      const r = await report(at, { reporter: a, title })
      await confirm(b, r)
      await confirm(c, r)
      await markFixed(d, r)

      const search = await app.inject({
        method: "GET",
        url: `/v1/reports/search${clientQuery({ q: title })}`,
      })
      expect(search.statusCode).toBe(200)
      expect(search.json().items.find((i: { id: string }) => i.id === r)).toMatchObject({
        confirmCount: 2,
        fixedCount: 1,
      })

      const list = await pressing(at)
      expect(list.statusCode).toBe(200)
      expect(list.json().items.find((i: { id: string }) => i.id === r)).toMatchObject({
        confirmCount: 2,
        fixedCount: 1,
      })
    })
  })

  describe("pressing ranking", () => {
    it("T17: P (10 confirmations, last five 4 seen 1 fixed) scores 8 and ranks above Q (6, all seen)", async () => {
      const at = region()
      const a = await resident()
      const q = await report(at, { reporter: a })
      const p = await report(at, { reporter: a })
      await seedVotes(p, [...seen(6), "fixed", ...seen(4)])
      await seedVotes(q, seen(6))
      expect(await pressingIds(at)).toEqual([p, q])
    })

    it("T18: S (12 confirmations, last five 2 seen 3 fixed) is dropped", async () => {
      const at = region()
      const a = await resident()
      const s = await report(at, { reporter: a })
      const k = await report(at, { reporter: a })
      await seedVotes(s, [...seen(10), "fixed", "seen", "fixed", "seen", "fixed"])
      await seedVotes(k, seen(1))
      expect(await pressingIds(at)).toEqual([k])
    })

    it("T19: V (1 confirmation) ranks above U (1 confirmation then 2 fixed votes, 1 / 3)", async () => {
      const at = region()
      const a = await resident()
      const v = await report(at, { reporter: a, createdAt: new Date(Date.now() - 60_000) })
      const u = await report(at, { reporter: a })
      await seedVotes(u, ["seen", "fixed", "fixed"])
      await seedVotes(v, seen(1))
      expect(await pressingIds(at)).toEqual([v, u])
    })

    it("T20: equal scores and counts: the newer report first", async () => {
      const at = region()
      const a = await resident()
      const w = await report(at, { reporter: a, createdAt: new Date(Date.now() - 60_000) })
      const x = await report(at, { reporter: a })
      await seedVotes(w, seen(5))
      await seedVotes(x, seen(5))
      expect(await pressingIds(at)).toEqual([x, w])
    })

    it("T21: Y (0 confirmations, 2 fixed votes) is not listed", async () => {
      const at = region()
      const a = await resident()
      const y = await report(at, { reporter: a })
      const k = await report(at, { reporter: a })
      await seedVotes(y, ["fixed", "fixed"])
      await seedVotes(k, seen(1))
      expect(await pressingIds(at)).toEqual([k])
    })

    it("T22: 25 qualifying reports list 20", async () => {
      const at = region()
      const a = await resident()
      for (let i = 0; i < 25; i += 1) await seedVotes(await report(at, { reporter: a }), seen(1))
      expect(await pressingIds(at)).toHaveLength(20)
    })

    it("T23: a vote moved from fixed to seen counts as the newest of the last five", async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      // M, oldest first: B's fixed vote, another fixed vote, then 4 newer seen votes. After B's move
      // the last five are B's (newest) and the 4 seen: 5 x 5 / 5 = 5. Were B's vote still at its old
      // time, they would be the 4 seen and the other fixed vote: 5 x 4 / 5 = 4.
      const m = await report(at, { reporter: a, createdAt: new Date(Date.now() - 60_000) })
      // The reference scores 6 x 4 / 5 = 4.8, between the two.
      const ref = await report(at, { reporter: a })
      const others = await voters(5)
      const base = Date.now() - 3_600_000
      await h.sql`
        INSERT INTO report_confirmations ${h.sql([
          { report_id: m, user_id: b.userId, kind: "fixed", created_at: new Date(base) },
          { report_id: m, user_id: others[0]!, kind: "fixed", created_at: new Date(base + 1000) },
          ...others.slice(1).map((userId, i) => ({
            report_id: m,
            user_id: userId,
            kind: "seen",
            created_at: new Date(base + (i + 2) * 1000),
          })),
        ])}
      `
      await h.sql`UPDATE reports SET confirm_count = 4, fixed_count = 2 WHERE id = ${m}`
      await seedVotes(ref, [...seen(2), "fixed", ...seen(4)])

      const moved = await confirm(b, m)
      expect(moved.statusCode).toBe(200)
      expect(body(moved)).toMatchObject({ confirmCount: 5, fixedCount: 1, confirmedByMe: true })
      expect(await pressingIds(at)).toEqual([m, ref])
    })

    it("T35: only the first 200 candidates are ranked", async () => {
      const at = region()
      const a = await resident()
      const people = await voters(5)
      const base = Date.now() - 3_600_000
      const top = await h.sql<{ id: string }[]>`
        INSERT INTO reports (
          reporter_user_id, idempotency_key, geom, geom_source, category, type, title, status, visibility,
          h3_cell, jurisdiction_geoid, confirm_count, fixed_count
        )
        SELECT ${a.userId}, gen_random_uuid(), ST_SetSRID(ST_MakePoint(${at.lng}, ${at.lat}), 4326),
               'device', 'trash', 'dump', 'Candidate ' || g, 'published', 'public', 'h0', ${LA_CITY.geoid},
               2, 3
        FROM generate_series(1, 200) AS g
        RETURNING id
      `
      // Each of the 200: two confirmations, then three newer fixed votes.
      await h.sql`
        INSERT INTO report_confirmations (report_id, user_id, kind, created_at)
        SELECT t.id, p.user_id, p.kind, ${new Date(base)}::timestamptz + p.ord * interval '1 second'
        FROM unnest(${top.map((t) => t.id)}::uuid[]) AS t(id)
        CROSS JOIN unnest(${people}::uuid[], ${["seen", "seen", "fixed", "fixed", "fixed"]}::text[])
          WITH ORDINALITY AS p(user_id, kind, ord)
      `
      const last = await report(at, { reporter: a })
      await seedVotes(last, seen(1))

      expect(await pressingIds(at)).toEqual([])
    })

    it("T36: the cache header stands and a wide bbox still walks the pressing index", async () => {
      const res = await pressing(region())
      expect(res.statusCode).toBe(200)
      expect(res.headers["cache-control"]).toBe("public, max-age=60")

      const plan = await explainPressingAlone(h.sql, { west: -179, south: -50, east: 21, north: 50 })
      expect(plan, plan).toContain(`Index Scan using ${PRESSING_INDEX}`)
    })
  })

  describe("admin", () => {
    function keysDeep(value: unknown): string[] {
      if (Array.isArray(value)) return value.flatMap(keysDeep)
      if (value !== null && typeof value === "object") {
        return Object.entries(value).flatMap(([k, v]) => [k, ...keysDeep(v)])
      }
      return []
    }

    async function confirmedTwiceFixedOnce(at: Region): Promise<string> {
      const [a, b, c, d] = [await resident(), await resident(), await resident(), await resident()]
      const r = await report(at, { reporter: a, title: `Fixed and confirmed ${randomUUID()}` })
      for (const res of [await confirm(b, r), await confirm(c, r), await markFixed(d, r)]) {
        expect(res.statusCode).toBe(200)
      }
      return r
    }

    it("T24: admin's list and detail send the confirmations only", async () => {
      const r = await confirmedTwiceFixedOnce(region())
      const op = await operator()
      const asOperator = { cookie: op.cookie }

      const list = await app.inject({
        method: "GET",
        url: "/v1/admin/reports",
        headers: asOperator,
      })
      expect(list.statusCode).toBe(200)
      const row = (list.json().items as { id: string; confirmations: number }[]).find(
        (x) => x.id === r,
      )
      expect(row?.confirmations).toBe(2)
      expect(keysDeep(row).filter((k) => /fixed/i.test(k))).toEqual([])

      const detail = await app.inject({
        method: "GET",
        url: `/v1/admin/reports/${r}`,
        headers: asOperator,
      })
      expect(detail.statusCode).toBe(200)
      expect(detail.json().confirmations).toBe(2)
      expect(keysDeep(detail.json()).filter((k) => /fixed/i.test(k))).toEqual([])
    })

    it("T34: the forward email's {confirmations} renders the confirmations only", async () => {
      const r = await confirmedTwiceFixedOnce(region())
      const op = await operator()
      await h.sql`
        INSERT INTO jurisdiction_contacts (geoid, category, email)
        VALUES (${LA_CITY.geoid}, NULL, 'forward-fixed@lacity.test')
        ON CONFLICT DO NOTHING
      `
      await h.sql`
        INSERT INTO forward_template_settings (id, body_template)
        VALUES (1, 'Neighbors who confirmed it: {confirmations}.')
        ON CONFLICT (id) DO UPDATE SET body_template = EXCLUDED.body_template
      `
      const routed = await app.inject({
        method: "POST",
        url: `/v1/admin/reports/${r}/route`,
        headers: { cookie: op.cookie, "x-csrf-token": op.csrfToken },
        payload: {},
      })
      expect(routed.statusCode).toBe(200)
      expect((container.mailer as FakeMailer).lastOutbound()?.text).toContain(
        "Neighbors who confirmed it: 2.",
      )
    })
  })

  describe("claim", () => {
    it("T25: claiming removes the claimant's fixed vote and its count", async () => {
      const at = region()
      const [b, c] = [await resident(), await resident()]
      const code = generateToken()
      const r = await report(at, { reporter: null, claimCodeHash: await sha256Hex(code) })
      await markFixed(b, r)
      await markFixed(c, r)
      expect((await stored(r)).fixedCount).toBe(2)

      const res = await app.inject({
        method: "POST",
        url: "/v1/claim/report",
        headers: headers(b),
        payload: { claimCode: code },
      })
      expect(res.statusCode).toBe(200)
      expect(await voteOf(r, b)).toBeUndefined()
      expect(await stored(r)).toMatchObject({ confirmCount: 0, fixedCount: 1 })
      expect(res.json().report).toMatchObject({ fixedCount: 1, fixedByMe: false })
    })
  })

  describe("account data", () => {
    it("T26: the data export splits the user's votes by kind", async () => {
      const at = region()
      const a = await resident()
      const b = await resident({ email: `b-${randomUUID()}@example.com` })
      const r1 = await report(at, { reporter: a })
      const r2 = await report(at, { reporter: a })
      await confirm(b, r1)
      await markFixed(b, r2)

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
        reportConfirmations: { reportId: string; createdAt: string }[]
        reportFixedVotes: { reportId: string; createdAt: string }[]
      }
      const [seenRow, fixedRow] = [(await voteOf(r1, b))!, (await voteOf(r2, b))!]
      expect(parsed.reportConfirmations).toEqual([
        { reportId: r1, createdAt: seenRow.created_at.toISOString() },
      ])
      expect(parsed.reportFixedVotes).toEqual([
        { reportId: r2, createdAt: fixedRow.created_at.toISOString() },
      ])
    })

    it("T38: a deleted account's fixed vote is kept and still counts", async () => {
      const at = region()
      const [a, b] = [await resident(), await resident()]
      const r = await report(at, { reporter: a })
      await markFixed(b, r)

      const deleted = await app.inject({
        method: "DELETE",
        url: "/v1/me",
        headers: headers(b),
        payload: { emailOtp: "000000" },
      })
      expect(deleted.statusCode).toBe(200)
      expect((await voteOf(r, b))?.kind).toBe("fixed")
      expect((await stored(r)).fixedCount).toBe(1)
    })
  })
})
