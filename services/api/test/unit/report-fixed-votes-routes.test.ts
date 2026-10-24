import { afterEach, describe, expect, it } from "vitest"
import type { LightMyRequestResponse } from "fastify"
import type { ReportRecord } from "../../src/services/report-repository.js"
import { makeAuthHarness, type AuthHarness } from "../helpers/auth.js"
import { InMemoryReportRepository } from "../helpers/reports.js"

/**
 * The guards on markReportFixed / unmarkReportFixed (session, CSRF, rate limit) and the vote routes' error
 * messages, through the real Fastify app over the in-memory report repository (test/helpers/reports.ts).
 * What the votes do to the rows and counts runs against PostGIS in
 * test/integration/report-fixed-votes-pg.test.ts.
 *
 * Setup, as in the slice's test cases: resident A filed report R (published); B is another resident.
 * Mutations go over a cookie session with its CSRF token unless a case says otherwise.
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
  r: ReportRecord
}

type Send = (
  h: Harness,
  s: WebSession,
  id: string,
  headers?: Record<string, string>,
) => Promise<LightMyRequestResponse>

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

async function makeHarness(): Promise<Harness> {
  const repo = new InMemoryReportRepository()
  const auth = await makeAuthHarness({
    server: {
      reportOverrides: {
        repo,
        resolveJurisdictionGeoid: () => Promise.resolve("0644000"),
        presignMedia: (r2Key) => Promise.resolve({ url: `memory://${r2Key}` }),
      },
    },
  })
  current = auth
  const a = await signInWeb(auth, "a@example.com")
  const b = await signInWeb(auth, "b@example.com")
  const r = repo.seedReport({ reporterUserId: a.userId, title: "Broken streetlight" })
  return { auth, repo, a, b, r }
}

function cookieHeaders(s: WebSession): Record<string, string> {
  return { cookie: s.cookie, "x-csrf-token": s.csrfToken }
}

function sender(method: "POST" | "DELETE", action: "confirm" | "fixed"): Send {
  return (h, s, id, headers = cookieHeaders(s)) =>
    h.auth.app.inject({ method, url: `/v1/reports/${id}/${action}`, headers })
}

const confirm = sender("POST", "confirm")
const unconfirm = sender("DELETE", "confirm")
const markFixed = sender("POST", "fixed")
const unmarkFixed = sender("DELETE", "fixed")

describe("markReportFixed / unmarkReportFixed guards", () => {
  it("T11: no session is UNAUTHORIZED", async () => {
    const h = await makeHarness()
    const res = await h.auth.app.inject({ method: "POST", url: `/v1/reports/${h.r.id}/fixed` })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe("UNAUTHORIZED")
  })

  it("T12: a cookie session needs the CSRF token; a bearer session does not", async () => {
    const h = await makeHarness()
    const refused = await markFixed(h, h.b, h.r.id, { cookie: h.b.cookie })
    expect(refused.statusCode).toBe(403)
    expect(refused.json().code).toBe("FORBIDDEN")
    expect(h.repo.reports.get(h.r.id)!.fixedCount).toBe(0)

    const token = await h.auth.services.sessions.createSession(h.b.userId, ["citizen"])
    const bearer = { authorization: `Bearer ${token}`, "x-client": "mobile" }
    const res = await markFixed(h, h.b, h.r.id, bearer)
    expect(res.statusCode).toBe(200)
  })

  it("T13: the 61st mark within a minute is RATE_LIMITED; the removal has its own bucket", async () => {
    const h = await makeHarness()
    for (let i = 0; i < 60; i += 1) {
      expect((await markFixed(h, h.b, h.r.id)).statusCode, `mark ${i + 1}`).toBe(200)
    }
    const over = await markFixed(h, h.b, h.r.id)
    expect(over.statusCode).toBe(429)
    expect(over.json().code).toBe("RATE_LIMITED")
    expect((await unmarkFixed(h, h.b, h.r.id)).statusCode).toBe(200)
  })

  it("T32: the 61st mark within a minute is RATE_LIMITED; confirm has its own bucket", async () => {
    const h = await makeHarness()
    for (let i = 0; i < 60; i += 1) {
      expect((await markFixed(h, h.b, h.r.id)).statusCode, `mark ${i + 1}`).toBe(200)
    }
    const over = await markFixed(h, h.b, h.r.id)
    expect(over.statusCode).toBe(429)
    expect(over.json().code).toBe("RATE_LIMITED")
    expect((await confirm(h, h.b, h.r.id)).statusCode).toBe(200)
  })
})

describe("vote route error messages", () => {
  it("T31: no FORBIDDEN or CONFLICT message of the four vote routes says Me too", async () => {
    const h = await makeHarness()
    const resolved = h.repo.seedReport({ reporterUserId: h.a.userId, status: "resolved" })
    const responses: LightMyRequestResponse[] = []
    for (const send of [confirm, unconfirm, markFixed, unmarkFixed]) {
      const forbidden = await send(h, h.a, h.r.id)
      expect(forbidden.statusCode).toBe(403)
      expect(forbidden.json().code).toBe("FORBIDDEN")
      responses.push(forbidden)
    }
    for (const send of [confirm, markFixed]) {
      const conflict = await send(h, h.b, resolved.id)
      expect(conflict.statusCode).toBe(409)
      expect(conflict.json().code).toBe("CONFLICT")
      responses.push(conflict)
    }
    for (const res of responses) {
      const { message } = res.json<{ message: string }>()
      expect(typeof message).toBe("string")
      expect(message).not.toMatch(/me too/i)
    }
  })
})
