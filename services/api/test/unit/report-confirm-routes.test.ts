import { afterEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { LightMyRequestResponse } from "fastify"
import type { ReportRecord } from "../../src/services/report-repository.js"
import { formatReferenceCode, typeCodeFor } from "../../src/db/reference-code.js"
import { makeAuthHarness, type AuthHarness } from "../helpers/auth.js"
import { InMemoryReportRepository } from "../helpers/reports.js"
import { clientQuery } from "../helpers/query.js"

/**
 * Me too (confirmReport / unconfirmReport) and the pressing list, through the real Fastify app over the
 * in-memory report repository (test/helpers/reports.ts). The SQL side of the same rules runs against
 * PostGIS in test/integration/report-confirmations-pg.test.ts.
 *
 * Setup, as in the slice's test cases: A filed report R (published, public, count 0); B and C are other
 * signed-in residents. Mutations go over a cookie session with its CSRF token unless a case says otherwise.
 */

interface WebSession {
  userId: string
  cookie: string
  csrfToken: string
}

interface Harness {
  auth: AuthHarness
  repo: InMemoryReportRepository
  a: WebSession
  b: WebSession
  c: WebSession
  r: ReportRecord
}

let current: AuthHarness | undefined

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

async function signInWeb(auth: AuthHarness, email: string): Promise<WebSession> {
  const requested = await auth.app.inject({
    method: "POST",
    url: "/v1/auth/otp/request",
    payload: { email },
  })
  expect(requested.statusCode).toBe(200)
  const code = auth.mailer.lastOtpFor(email)!
  const res = await auth.app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "web" },
    payload: { email, code },
  })
  expect(res.statusCode).toBe(200)
  const setCookie = res.headers["set-cookie"]
  const lines = Array.isArray(setCookie) ? setCookie : [String(setCookie)]
  const cookie = lines.find((l) => l.startsWith("civfix_session="))!.split(";")[0]!
  return { userId: res.json().user.id as string, cookie, csrfToken: res.json().csrfToken as string }
}

const LA = { lat: 34.1, lng: -118.35 }
const BBOX = { west: -118.4, south: 34.05, east: -118.3, north: 34.15 }

async function makeHarness(): Promise<Harness> {
  const repo = new InMemoryReportRepository()
  const auth = await makeAuthHarness({
    server: {
      reportOverrides: {
        repo,
        resolveJurisdictionGeoid: () => Promise.resolve("0644000"),
        presignMedia: (r2Key, thumbKey) =>
          Promise.resolve(
            thumbKey === null
              ? { url: `memory://${r2Key}` }
              : { url: `memory://${r2Key}`, thumbUrl: `memory://${thumbKey}` },
          ),
      },
    },
  })
  current = auth
  const a = await signInWeb(auth, "a@example.com")
  const b = await signInWeb(auth, "b@example.com")
  const c = await signInWeb(auth, "c@example.com")
  const r = repo.seedReport({ reporterUserId: a.userId, title: "Broken streetlight", ...LA })
  return { auth, repo, a, b, c, r }
}

function cookieHeaders(s: WebSession): Record<string, string> {
  return { cookie: s.cookie, "x-csrf-token": s.csrfToken }
}

function confirm(
  h: Harness,
  s: WebSession,
  id: string,
  headers: Record<string, string> = cookieHeaders(s),
): Promise<LightMyRequestResponse> {
  return h.auth.app.inject({ method: "POST", url: `/v1/reports/${id}/confirm`, headers })
}

function unconfirm(
  h: Harness,
  s: WebSession,
  id: string,
  headers: Record<string, string> = cookieHeaders(s),
): Promise<LightMyRequestResponse> {
  return h.auth.app.inject({ method: "DELETE", url: `/v1/reports/${id}/confirm`, headers })
}

function getReport(h: Harness, id: string, s?: WebSession): Promise<LightMyRequestResponse> {
  return h.auth.app.inject({
    method: "GET",
    url: `/v1/reports/${id}`,
    ...(s ? { headers: { cookie: s.cookie } } : {}),
  })
}

function pressing(
  h: Harness,
  query: Record<string, unknown>,
  s?: WebSession,
): Promise<LightMyRequestResponse> {
  return h.auth.app.inject({
    method: "GET",
    url: `/v1/reports/pressing${clientQuery(query)}`,
    ...(s ? { headers: { cookie: s.cookie } } : {}),
  })
}

function rowsOf(h: Harness, reportId: string): string[] {
  return [...(h.repo.confirmations.get(reportId)?.keys() ?? [])]
}

function countOf(h: Harness, reportId: string): number {
  return h.repo.reports.get(reportId)!.confirmCount
}

/** The error body without its per-request trace id, which differs on every response by design. */
function errorBody(res: LightMyRequestResponse): Record<string, unknown> {
  const { requestId: _requestId, ...rest } = res.json<Record<string, unknown>>()
  return rest
}

describe("POST /v1/reports/:id/confirm", () => {
  it("T1: B confirms R", async () => {
    const h = await makeHarness()
    const res = await confirm(h, h.b, h.r.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      confirmCount: 1,
      confirmedByMe: true,
      fixedCount: 0,
      fixedByMe: false,
    })
    expect(rowsOf(h, h.r.id)).toEqual([h.b.userId])
    expect(countOf(h, h.r.id)).toBe(1)
  })

  it("T2: B confirms R a second time", async () => {
    const h = await makeHarness()
    await confirm(h, h.b, h.r.id)
    const res = await confirm(h, h.b, h.r.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      confirmCount: 1,
      confirmedByMe: true,
      fixedCount: 0,
      fixedByMe: false,
    })
    expect(rowsOf(h, h.r.id)).toEqual([h.b.userId])
    expect(countOf(h, h.r.id)).toBe(1)
  })

  it("T3: after T1, C confirms R", async () => {
    const h = await makeHarness()
    await confirm(h, h.b, h.r.id)
    const res = await confirm(h, h.c, h.r.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      confirmCount: 2,
      confirmedByMe: true,
      fixedCount: 0,
      fixedByMe: false,
    })
  })

  it("T4: B confirms an acknowledged R and an in_progress second report", async () => {
    const h = await makeHarness()
    h.repo.reports.get(h.r.id)!.status = "acknowledged"
    const second = h.repo.seedReport({ reporterUserId: h.a.userId, status: "in_progress", ...LA })
    for (const id of [h.r.id, second.id]) {
      const res = await confirm(h, h.b, id)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        confirmCount: 1,
        confirmedByMe: true,
        fixedCount: 0,
        fixedByMe: false,
      })
    }
  })

  it("T9: C confirms a resolved R that B confirmed earlier", async () => {
    const h = await makeHarness()
    await confirm(h, h.b, h.r.id)
    h.repo.reports.get(h.r.id)!.status = "resolved"
    const res = await confirm(h, h.c, h.r.id)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe("CONFLICT")
    expect(countOf(h, h.r.id)).toBe(1)
    expect(rowsOf(h, h.r.id)).not.toContain(h.c.userId)
  })
})

describe("DELETE /v1/reports/:id/confirm", () => {
  it("T5: B and C confirmed R (count 2); B removes", async () => {
    const h = await makeHarness()
    await confirm(h, h.b, h.r.id)
    await confirm(h, h.c, h.r.id)
    const res = await unconfirm(h, h.b, h.r.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      confirmCount: 1,
      confirmedByMe: false,
      fixedCount: 0,
      fixedByMe: false,
    })
    expect(rowsOf(h, h.r.id)).toEqual([h.c.userId])
  })

  it("T6: after T5, B removes again", async () => {
    const h = await makeHarness()
    await confirm(h, h.b, h.r.id)
    await confirm(h, h.c, h.r.id)
    await unconfirm(h, h.b, h.r.id)
    const res = await unconfirm(h, h.b, h.r.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      confirmCount: 1,
      confirmedByMe: false,
      fixedCount: 0,
      fixedByMe: false,
    })
    expect(countOf(h, h.r.id)).toBe(1)
  })

  it("T7: nobody confirmed R (count 0); B removes", async () => {
    const h = await makeHarness()
    const res = await unconfirm(h, h.b, h.r.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      confirmCount: 0,
      confirmedByMe: false,
      fixedCount: 0,
      fixedByMe: false,
    })
    expect(countOf(h, h.r.id)).toBe(0)
  })

  it("T8: B confirmed R, an operator resolved it, B removes", async () => {
    const h = await makeHarness()
    await confirm(h, h.b, h.r.id)
    h.repo.reports.get(h.r.id)!.status = "resolved"
    const res = await unconfirm(h, h.b, h.r.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      confirmCount: 0,
      confirmedByMe: false,
      fixedCount: 0,
      fixedByMe: false,
    })
    expect(rowsOf(h, h.r.id)).toEqual([])
  })
})

describe("confirm and remove: errors", () => {
  it("T10: A on own open public R is FORBIDDEN for both", async () => {
    const h = await makeHarness()
    for (const send of [confirm, unconfirm]) {
      const res = await send(h, h.a, h.r.id)
      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe("FORBIDDEN")
    }
    expect(countOf(h, h.r.id)).toBe(0)
  })

  it("T11: A on own resolved public R is FORBIDDEN for both (ownership before the resolved check)", async () => {
    const h = await makeHarness()
    h.repo.reports.get(h.r.id)!.status = "resolved"
    for (const send of [confirm, unconfirm]) {
      const res = await send(h, h.a, h.r.id)
      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe("FORBIDDEN")
    }
  })

  it("T12: unknown, hidden, held, submitted, rejected and deleted reports are NOT_FOUND alike, for B and for A", async () => {
    const h = await makeHarness()
    const owned = (over: Partial<ReportRecord>) =>
      h.repo.seedReport({ reporterUserId: h.a.userId, ...LA, ...over }).id
    const targets = [
      randomUUID(),
      owned({ visibility: "hidden" }),
      owned({ status: "held" }),
      owned({ status: "submitted" }),
      owned({ status: "rejected" }),
      owned({ deletedAt: new Date() }),
    ]
    const unknown = errorBody(await confirm(h, h.b, targets[0]!))

    for (const caller of [h.b, h.a]) {
      for (const id of targets) {
        for (const send of [confirm, unconfirm]) {
          const res = await send(h, caller, id)
          expect(res.statusCode, `${send.name} ${id}`).toBe(404)
          expect(res.json().code).toBe("NOT_FOUND")
          expect(errorBody(res)).toEqual(unknown)
        }
        expect(h.repo.confirmations.get(id)?.size ?? 0).toBe(0)
        expect(h.repo.reports.get(id)?.confirmCount ?? 0).toBe(0)
      }
    }
  })

  it("T13: no session is UNAUTHORIZED, on R and on a hidden report", async () => {
    const h = await makeHarness()
    const hidden = h.repo.seedReport({ reporterUserId: h.a.userId, visibility: "hidden", ...LA })
    for (const id of [h.r.id, hidden.id]) {
      for (const method of ["POST", "DELETE"] as const) {
        const res = await h.auth.app.inject({ method, url: `/v1/reports/${id}/confirm` })
        expect(res.statusCode).toBe(401)
        expect(res.json().code).toBe("UNAUTHORIZED")
      }
    }
  })

  it("T14: a non-UUID id is VALIDATION", async () => {
    const h = await makeHarness()
    for (const send of [confirm, unconfirm]) {
      const res = await send(h, h.b, "not-a-uuid")
      expect(res.statusCode).toBe(422)
      expect(res.json().code).toBe("VALIDATION")
    }
  })

  it("T15: a cookie session needs the CSRF token; a bearer session does not", async () => {
    const h = await makeHarness()
    for (const send of [confirm, unconfirm]) {
      const res = await send(h, h.b, h.r.id, { cookie: h.b.cookie })
      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe("FORBIDDEN")
    }
    expect(rowsOf(h, h.r.id)).toEqual([])
    expect(countOf(h, h.r.id)).toBe(0)

    const token = await h.auth.services.sessions.createSession(h.b.userId, ["citizen"])
    const bearer = { authorization: `Bearer ${token}`, "x-client": "mobile" }
    expect((await confirm(h, h.b, h.r.id, bearer)).statusCode).toBe(200)
    expect((await unconfirm(h, h.b, h.r.id, bearer)).statusCode).toBe(200)
  })

  it("T16: each route has its own 60-per-minute bucket per identity", async () => {
    const h = await makeHarness()
    for (let i = 0; i < 60; i += 1) {
      expect((await confirm(h, h.b, h.r.id)).statusCode, `confirm ${i + 1}`).toBe(200)
    }
    const over = await confirm(h, h.b, h.r.id)
    expect(over.statusCode).toBe(429)
    expect(over.json().code).toBe("RATE_LIMITED")

    expect((await unconfirm(h, h.b, h.r.id)).statusCode).toBe(200)
    expect((await confirm(h, h.c, h.r.id)).statusCode).toBe(200)

    for (let i = 1; i < 60; i += 1) {
      expect((await unconfirm(h, h.b, h.r.id)).statusCode, `remove ${i + 1}`).toBe(200)
    }
    const overRemove = await unconfirm(h, h.b, h.r.id)
    expect(overRemove.statusCode).toBe(429)
    expect(overRemove.json().code).toBe("RATE_LIMITED")
  })
})

describe("confirmCount and confirmedByMe on report reads", () => {
  it("T17: GET /v1/reports/:id after B and C confirmed and C removed", async () => {
    const h = await makeHarness()
    const referenceCode = formatReferenceCode(typeCodeFor("dump"), 6, 42)
    h.repo.reports.get(h.r.id)!.referenceCode = referenceCode
    await confirm(h, h.b, h.r.id)
    await confirm(h, h.c, h.r.id)
    await unconfirm(h, h.c, h.r.id)

    const seen = async (s?: WebSession, id = h.r.id) => {
      const res = await getReport(h, id, s)
      expect(res.statusCode).toBe(200)
      const { confirmCount, confirmedByMe } = res.json()
      return { confirmCount, confirmedByMe }
    }
    expect(await seen(h.b)).toEqual({ confirmCount: 1, confirmedByMe: true })
    expect(await seen(h.c)).toEqual({ confirmCount: 1, confirmedByMe: false })
    expect(await seen(h.a)).toEqual({ confirmCount: 1, confirmedByMe: false })
    expect(await seen()).toEqual({ confirmCount: 1, confirmedByMe: false })
    expect(await seen(h.b, referenceCode)).toEqual({ confirmCount: 1, confirmedByMe: true })
  })

  it("T18: createReport and its idempotent replay send 0 / false", async () => {
    const h = await makeHarness()
    const payload = {
      idempotencyKey: randomUUID(),
      category: "trash",
      type: "dump",
      description: "mattress on the curb",
      ...LA,
      geomSource: "device",
      mediaUploadIds: [],
    }
    for (const expected of [201, 201]) {
      const res = await h.auth.app.inject({
        method: "POST",
        url: "/v1/reports",
        headers: cookieHeaders(h.a),
        payload,
      })
      expect(res.statusCode).toBe(expected)
      expect(res.json().confirmCount).toBe(0)
      expect(res.json().confirmedByMe).toBe(false)
    }
  })

  it("T19: listMyReports sends the count and confirmedByMe false", async () => {
    const h = await makeHarness()
    await confirm(h, h.b, h.r.id)
    const res = await h.auth.app.inject({
      method: "GET",
      url: "/v1/reports",
      headers: { cookie: h.a.cookie },
    })
    expect(res.statusCode).toBe(200)
    const item = res.json().items.find((i: { id: string }) => i.id === h.r.id)
    expect(item.confirmCount).toBe(1)
    expect(item.confirmedByMe).toBe(false)
  })

  it("T20: resolveReport answers with the count and confirmedByMe false", async () => {
    const h = await makeHarness()
    await confirm(h, h.b, h.r.id)
    const res = await h.auth.app.inject({
      method: "POST",
      url: `/v1/reports/${h.r.id}/resolve`,
      headers: cookieHeaders(h.a),
      payload: { resolved: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().confirmCount).toBe(1)
    expect(res.json().confirmedByMe).toBe(false)
  })

  it("T21: map pins carry confirmCount through the route's response JSON schema", async () => {
    const h = await makeHarness()
    const s = h.repo.seedReport({ reporterUserId: h.a.userId, lat: 34.11, lng: -118.34 })
    await confirm(h, h.b, h.r.id)
    await confirm(h, h.c, h.r.id)
    const res = await h.auth.app.inject({
      method: "GET",
      url: `/v1/map/reports${clientQuery({ bbox: BBOX, zoom: 18 })}`,
    })
    expect(res.statusCode).toBe(200)
    const pins = res.json().pins as { id: string; confirmCount: number }[]
    expect(pins.find((p) => p.id === h.r.id)?.confirmCount).toBe(2)
    expect(pins.find((p) => p.id === s.id)?.confirmCount).toBe(0)
  })

  it("T22: search items carry confirmCount", async () => {
    const h = await makeHarness()
    await confirm(h, h.b, h.r.id)
    await confirm(h, h.c, h.r.id)
    const res = await h.auth.app.inject({
      method: "GET",
      url: `/v1/reports/search${clientQuery({ q: "Broken streetlight" })}`,
    })
    expect(res.statusCode).toBe(200)
    const item = res.json().items.find((i: { id: string }) => i.id === h.r.id)
    expect(item.confirmCount).toBe(2)
  })
})

describe("GET /v1/reports/pressing", () => {
  function seedCounted(h: Harness, count: number, over: Partial<ReportRecord> = {}): ReportRecord {
    const report = h.repo.seedReport({ reporterUserId: h.a.userId, ...LA, ...over })
    for (let i = 0; i < count; i += 1) h.repo.seedConfirmation(report.id)
    return report
  }

  function seedT24(h: Harness): Record<"p1" | "p2" | "p3" | "p4", ReportRecord> {
    const p1 = seedCounted(h, 3, { createdAt: new Date("2026-02-01T00:00:00.000Z") })
    const p2 = seedCounted(h, 3, { createdAt: new Date("2026-02-02T00:00:00.000Z") })
    const p3 = seedCounted(h, 5)
    const p4 = seedCounted(h, 1)
    return { p1, p2, p3, p4 }
  }

  it("T23: a bbox with nothing confirmed is an empty list, cacheable for 60s", async () => {
    const h = await makeHarness()
    const res = await pressing(h, { bbox: BBOX })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [] })
    expect(res.headers["cache-control"]).toBe("public, max-age=60")
  })

  it("T24: most confirmed first, then newest", async () => {
    const h = await makeHarness()
    const { p1, p2, p3, p4 } = seedT24(h)
    const res = await pressing(h, { bbox: BBOX })
    expect(res.statusCode).toBe(200)
    const items = res.json().items as { id: string; confirmCount: number }[]
    expect(items.map((i) => i.id)).toEqual([p3.id, p2.id, p1.id, p4.id])
    expect(items.map((i) => i.confirmCount)).toEqual([5, 3, 3, 1])
  })

  it("T25: only open public reports in the bbox with a count of at least 1", async () => {
    const h = await makeHarness()
    seedCounted(h, 2, { status: "resolved" })
    seedCounted(h, 2, { visibility: "hidden" })
    seedCounted(h, 2, { status: "held" })
    seedCounted(h, 2, { status: "submitted" })
    seedCounted(h, 2, { status: "rejected" })
    seedCounted(h, 2, { deletedAt: new Date() })
    seedCounted(h, 0)
    seedCounted(h, 1, { lat: 40.7, lng: -74 })
    const k = seedCounted(h, 1)
    const res = await pressing(h, { bbox: BBOX })
    expect(res.statusCode).toBe(200)
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual([k.id])
  })

  it("T26: at most 20 items", async () => {
    const h = await makeHarness()
    for (let n = 1; n <= 25; n += 1) seedCounted(h, n)
    const res = await pressing(h, { bbox: BBOX })
    expect(res.statusCode).toBe(200)
    const counts = res.json().items.map((i: { confirmCount: number }) => i.confirmCount)
    expect(counts).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i))
  })

  it("T27: a signed-in caller gets the guest's body", async () => {
    const h = await makeHarness()
    seedT24(h)
    const guest = await pressing(h, { bbox: BBOX })
    const signedIn = await pressing(h, { bbox: BBOX }, h.b)
    expect(signedIn.statusCode).toBe(200)
    expect(signedIn.json()).toEqual(guest.json())
  })

  it("T28: mapReports' bbox rules", async () => {
    const h = await makeHarness()
    const bad = [
      "",
      clientQuery({ bbox: { west: -118.3, south: 34.05, east: -118.4, north: 34.15 } }),
      clientQuery({ bbox: { west: -180, south: -80, east: 180, north: 80 } }),
      "?bbox=not-json",
    ]
    for (const qs of bad) {
      const res = await h.auth.app.inject({ method: "GET", url: `/v1/reports/pressing${qs}` })
      expect(res.statusCode, qs).toBe(422)
      expect(res.json().code).toBe("VALIDATION")
    }
  })

  it("T29: 60 requests per minute per IP", async () => {
    const h = await makeHarness()
    for (let i = 0; i < 60; i += 1) {
      expect((await pressing(h, { bbox: BBOX })).statusCode, `request ${i + 1}`).toBe(200)
    }
    const over = await pressing(h, { bbox: BBOX })
    expect(over.statusCode).toBe(429)
    expect(over.json().code).toBe("RATE_LIMITED")
  })

  it("T30: a pin with a ready photo has a thumbUrl; one without has null", async () => {
    const h = await makeHarness()
    const { p1, p4 } = seedT24(h)
    h.repo.seedMedia({ reportId: p1.id, status: "ready", kind: "image" })
    const res = await pressing(h, { bbox: BBOX })
    const items = res.json().items as { id: string; thumbUrl: string | null }[]
    expect(items.find((i) => i.id === p1.id)?.thumbUrl).toMatch(/^memory:\/\//)
    expect(items.find((i) => i.id === p4.id)?.thumbUrl).toBeNull()
  })
})

describe("privacy", () => {
  it("T38: no public response names who confirmed", async () => {
    const h = await makeHarness()
    const bodies: string[] = []
    const keep = (res: LightMyRequestResponse) => {
      expect(res.statusCode).toBeLessThan(300)
      bodies.push(res.body)
    }
    keep(await confirm(h, h.b, h.r.id))
    keep(await confirm(h, h.c, h.r.id))
    keep(await getReport(h, h.r.id, h.a))
    keep(await getReport(h, h.r.id))
    keep(
      await h.auth.app.inject({
        method: "GET",
        url: `/v1/map/reports${clientQuery({ bbox: BBOX, zoom: 18 })}`,
      }),
    )
    keep(
      await h.auth.app.inject({
        method: "GET",
        url: `/v1/reports/search${clientQuery({ q: "Broken streetlight" })}`,
      }),
    )
    keep(await pressing(h, { bbox: BBOX }))
    keep(await unconfirm(h, h.c, h.r.id))

    const secrets: string[] = []
    for (const s of [h.b, h.c]) {
      const user = await h.auth.stores.users.findById(s.userId)
      secrets.push(s.userId, ...(user?.handle ? [user.handle] : []))
    }
    for (const body of bodies) {
      for (const secret of secrets) expect(body).not.toContain(secret)
    }
  })
})
