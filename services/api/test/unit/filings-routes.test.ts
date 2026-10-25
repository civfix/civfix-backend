import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import { FakeMailer, FakeStorage } from "@civfix/seams"
import { ReportCategorySchema } from "@civfix/contract"
import { endpoints, versionedPath } from "@civfix/contract/client"
import { makeServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { makeAuthServices } from "../../src/auth/auth-services.js"
import { FILING_EMAIL_JOB } from "../../src/lib/queue-names.js"
import type { CreateFilingInput, FilingRecord } from "../../src/services/filings/filing-types.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryHomeRepository } from "../helpers/admin/home-repository.memory.js"
import { InMemoryAnalyticsRepository } from "../helpers/admin/analytics-repository.memory.js"
import { InMemoryJurisdictionContactsRepository } from "../helpers/admin/jurisdiction-contacts-repository.memory.js"
import {
  filingHarness,
  J_CONTACT,
  J_GEOID,
  J_NAME,
  PORTAL_HOST,
  PORTAL_URL,
  type FilingHarness,
  type SeedInput,
} from "../helpers/filings/filing-harness.js"

const OPERATOR = "ops@civfix.org"
const UNKNOWN_ID = "99999999-9999-4999-8999-999999999999"

type FilingEndpoint =
  | "fileReport"
  | "listFilings"
  | "getFiling"
  | "retryFiling"
  | "cancelFiling"
  | "recordManualFiling"
  | "getFilingSettings"
  | "setFilingSettings"
  | "listFilingRoutes"
  | "saveFilingRoutes"

const FILING_ENDPOINTS: readonly FilingEndpoint[] = [
  "fileReport",
  "listFilings",
  "getFiling",
  "retryFiling",
  "cancelFiling",
  "recordManualFiling",
  "getFilingSettings",
  "setFilingSettings",
  "listFilingRoutes",
  "saveFilingRoutes",
]

interface Harness {
  app: FastifyInstance
  f: FilingHarness
  storage: FakeStorage
  token: string
  citizenToken: string
  operatorId: string
}

async function makeHarness(): Promise<Harness> {
  const stores = makeInMemoryStores()
  const services = makeAuthServices({
    stores,
    cache: new InMemoryCacheClient(() => Date.now()),
    mailer: new FakeMailer(),
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  const env = loadEnv({ NODE_ENV: "test", ADMIN_EMAILS: OPERATOR })
  const app = await makeServer({ env, authServices: services })
  const f = filingHarness()
  const storage = new FakeStorage()
  const jurisdictions = new InMemoryJurisdictionContactsRepository()
  jurisdictions.seedJurisdiction({ geoid: J_GEOID, name: J_NAME, defaultEmails: [J_CONTACT] })
  app.filingOverrides = {
    filings: f.filings,
    reports: f.reports,
    jurisdictions,
    service: f.svc,
    storage,
    automaticFiling: false,
  }
  app.homeOverrides = {
    repo: new InMemoryHomeRepository(),
    analytics: new InMemoryAnalyticsRepository(),
    filings: f.filings,
  }

  const operator = await stores.users.create(OPERATOR, {
    displayName: "Ops",
    role: "operator",
    emailVerified: true,
  })
  const token = await services.sessions.createSession(operator.id, ["operator"])
  const citizen = await stores.users.create("sam@example.com", {
    displayName: "Sam",
    role: "citizen",
    emailVerified: true,
  })
  const citizenToken = await services.sessions.createSession(citizen.id, ["citizen"])
  return { app, f, storage, token, citizenToken, operatorId: operator.id }
}

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
  vi.restoreAllMocks()
})

interface CallOptions {
  params?: Record<string, string>
  query?: Record<string, string>
  body?: unknown
  token?: string
}

function call(
  name: FilingEndpoint | "adminHomeSummary",
  opts: CallOptions = {},
): Promise<LightMyRequestResponse> {
  const ep = endpoints[name]
  let url = versionedPath(ep)
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    url = url.replace(`:${key}`, encodeURIComponent(value))
  }
  if (opts.query !== undefined) url += `?${new URLSearchParams(opts.query).toString()}`
  const headers = { authorization: `Bearer ${opts.token ?? h.token}` }
  return ep.method === "GET"
    ? h.app.inject({ method: "GET", url, headers })
    : h.app.inject({ method: ep.method, url, headers, payload: (opts.body ?? {}) as object })
}

interface FilingJson {
  id: string
  status: string
  reason: string | null
  channel: string | null
  attempts: number
  method: string | null
  caseId: string | null
  caseUrl: string | null
  reportTitle: string
  jurisdictionName: string | null
  updatedAt: string
  evidence?: { url: string }[]
}

function filingOf(res: LightMyRequestResponse): FilingJson {
  return res.json<{ filing: FilingJson }>().filing
}

function expectError(res: LightMyRequestResponse, status: number, code: string): void {
  expect(res.statusCode, res.body).toBe(status)
  const body = res.json<{ code: string; message?: string }>()
  expect(body.code).toBe(code)
  // Fastify's own 404 for an unregistered route is NOT_FOUND too; it must not pass for the handler's.
  expect(body.message ?? "", "the route is not registered").not.toMatch(/^Route /)
}

function report(input: SeedInput = {}): string {
  return h.f.seed({ verificationVerdict: "approved", contact: J_CONTACT, ...input }).record.id
}

function filing(
  patch: Partial<FilingRecord>,
  input: Partial<CreateFilingInput> = {},
  reportInput: SeedInput = {},
): Promise<FilingRecord> {
  return h.f.addFiling(report(reportInput), { channel: "email", ...input }, patch)
}

const emailRoute = (category: string | null = null) => ({
  category,
  channel: "email",
  formUrl: null,
  requestTypeHint: null,
})

const portalRoute = (formUrl: string, category: string | null = null) => ({
  category,
  channel: "portal",
  formUrl,
  requestTypeHint: null,
})

describe("fileReport", () => {
  it("T1: files an approved report once, then CONFLICT", async () => {
    const id = report()
    const first = await call("fileReport", { params: { id } })
    expect(first.statusCode, first.body).toBe(200)
    const filed = filingOf(first)
    expect(["queued", "needs_human"]).toContain(filed.status)
    expect("evidence" in filed).toBe(false)

    expectError(await call("fileReport", { params: { id } }), 409, "CONFLICT")
  })

  it("T2: a report whose verdict is rejected is CONFLICT and gets no filing", async () => {
    const id = report({ verificationVerdict: "rejected" })
    expectError(await call("fileReport", { params: { id } }), 409, "CONFLICT")
    expect(h.f.filings.filings.size).toBe(0)
  })

  it("T3: an unknown or removed report is NOT_FOUND without calling create", async () => {
    const create = vi.spyOn(h.f.svc, "create")
    expectError(await call("fileReport", { params: { id: UNKNOWN_ID } }), 404, "NOT_FOUND")

    const removed = h.f.seed({ verificationVerdict: "approved", contact: J_CONTACT })
    removed.deletedAt = new Date()
    expectError(await call("fileReport", { params: { id: removed.record.id } }), 404, "NOT_FOUND")
    expect(create).not.toHaveBeenCalled()
    expect(h.f.filings.filings.size).toBe(0)
  })

  it("T4: the eleventh fileReport in a minute by one operator is RATE_LIMITED", async () => {
    const id = report()
    for (let i = 0; i < 10; i += 1) {
      const res = await call("fileReport", { params: { id } })
      expect(res.statusCode, `call ${i + 1}`).not.toBe(429)
    }
    expectError(await call("fileReport", { params: { id } }), 429, "RATE_LIMITED")
  })
})

describe("listFilings and getFiling", () => {
  it("T5: pages 51 needs_human filings as 50 then 1, newest update first", async () => {
    const base = Date.parse("2026-10-01T00:00:00.000Z")
    const seeded: FilingRecord[] = []
    for (let i = 0; i < 51; i += 1) {
      seeded.push(
        await filing({
          status: "needs_human",
          reason: "no_route",
          updatedAt: new Date(base + i * 1000),
        }),
      )
    }
    const newestFirst = [...seeded]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((s) => s.id)

    const first = await call("listFilings", { query: { group: "needs_human" } })
    expect(first.statusCode, first.body).toBe(200)
    const page1 = first.json<{
      items: FilingJson[]
      nextCursor: string | null
      counts: { needs_human: number }
    }>()
    expect(page1.items.map((i) => i.id)).toEqual(newestFirst.slice(0, 50))
    for (const item of page1.items) {
      expect(item.reportTitle).toBe("Pothole")
      expect(item.jurisdictionName).toBe(J_NAME)
    }
    expect(page1.counts.needs_human).toBe(51)
    expect(page1.nextCursor).not.toBeNull()

    const second = await call("listFilings", {
      query: { group: "needs_human", cursor: page1.nextCursor ?? "" },
    })
    expect(second.statusCode, second.body).toBe(200)
    const page2 = second.json<{
      items: FilingJson[]
      nextCursor: string | null
      counts: { needs_human: number }
    }>()
    expect(page2.items.map((i) => i.id)).toEqual(newestFirst.slice(50))
    expect(page2.nextCursor).toBeNull()
    expect(page2.counts.needs_human).toBe(51)
  })

  it("T6: a bad group or an undecodable cursor is VALIDATION", async () => {
    expectError(await call("listFilings", { query: { group: "bogus" } }), 422, "VALIDATION")
    expectError(
      await call("listFilings", { query: { group: "needs_human", cursor: "!!" } }),
      422,
      "VALIDATION",
    )
  })

  it("T7: each evidence url is a signed GET for 900 seconds with forceSigned", async () => {
    const f = await filing({ status: "needs_human", reason: "captcha" })
    const key = `filings/${f.id}/shot-1.png`
    h.f.filings.evidence.push({
      id: randomUUID(),
      filingId: f.id,
      r2Key: key,
      kind: "screenshot",
      label: "Confirmation page",
      createdAt: new Date(),
    })
    const presign = vi.spyOn(h.storage, "presignGet")

    const res = await call("getFiling", { params: { id: f.id } })
    expect(res.statusCode, res.body).toBe(200)
    expect(presign).toHaveBeenCalledWith(key, 900, { forceSigned: true })
    expect(filingOf(res).evidence?.[0]?.url).toBe(await presign.mock.results[0]?.value)
  })

  it("T8: an unknown filing is NOT_FOUND; a malformed id is VALIDATION", async () => {
    expectError(await call("getFiling", { params: { id: UNKNOWN_ID } }), 404, "NOT_FOUND")
    expectError(await call("getFiling", { params: { id: "abc" } }), 422, "VALIDATION")
  })
})

describe("retryFiling and cancelFiling", () => {
  it("T9: Retry re-resolves a route saved since and queues the filing", async () => {
    const f = await filing({ status: "needs_human", reason: "no_route", channel: null })
    await h.f.filings.replaceRoutes(J_GEOID, [{ category: null, channel: "email" }])
    const enqueue = vi.spyOn(h.f.svc, "enqueueFiling")

    const res = await call("retryFiling", { params: { id: f.id } })
    expect(res.statusCode, res.body).toBe(200)
    const retried = filingOf(res)
    expect(retried).toMatchObject({ channel: "email", status: "queued", attempts: 0, reason: null })
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ id: f.id, channel: "email", status: "queued" }),
    )
    expect(h.f.filings.audits.filter((a) => a.action === "filing.retried")).toHaveLength(1)
  })

  it("T10: Retry of a portal filing with automatic filing off is needs_human filing_off", async () => {
    await h.f.filings.replaceRoutes(J_GEOID, [
      { category: null, channel: "portal", formUrl: PORTAL_URL },
    ])
    const f = await filing(
      {
        status: "needs_human",
        reason: "attempts_exhausted",
        attempts: 3,
        aiWaitSince: new Date(),
      },
      { channel: "portal", portalHost: PORTAL_HOST, formUrl: PORTAL_URL },
    )

    const res = await call("retryFiling", { params: { id: f.id } })
    expect(res.statusCode, res.body).toBe(200)
    expect(filingOf(res)).toMatchObject({
      status: "needs_human",
      reason: "filing_off",
      attempts: 0,
    })
    expect(h.f.filings.filings.get(f.id)?.aiWaitSince).toBeNull()
    expect(h.f.jobs.enqueued).toEqual([])
  })

  it("T11: Retry and Cancel are CONFLICT on city_needs_info, submitted and running", async () => {
    const filings = [
      await filing({ status: "needs_human", reason: "city_needs_info", caseId: "1-555" }),
      await filing({ status: "submitted", method: "email" }),
      await filing({ status: "running", attempts: 1 }),
    ]
    for (const f of filings) {
      expectError(await call("retryFiling", { params: { id: f.id } }), 409, "CONFLICT")
      expectError(await call("cancelFiling", { params: { id: f.id } }), 409, "CONFLICT")
    }
  })
})

describe("recordManualFiling", () => {
  it("T12: a manual filing on a queued filing applies the success through applyFilingSuccess", async () => {
    const f = await filing({ status: "queued" })
    const apply = vi.spyOn(h.f.svc, "applyFilingSuccess")
    const caseUrl = "https://myla311.lacity.gov/s/case/1"

    const res = await call("recordManualFiling", {
      params: { id: f.id },
      body: { caseId: "1-555", caseUrl },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ filingId: f.id, method: "operator", caseId: "1-555", caseUrl }),
    )
    expect(filingOf(res)).toMatchObject({ status: "submitted", caseId: "1-555" })
    expect(h.f.reports.reports.get(f.reportId)?.record.status).toBe("acknowledged")
    expect(h.f.reports.timeline.get(f.reportId)?.at(-1)?.note).toBe(
      `Filed with ${J_NAME} · Request 1-555`,
    )
  })

  it("T13: a manual filing on city_needs_info changes only the filing", async () => {
    const f = await filing(
      { status: "needs_human", reason: "city_needs_info", caseId: "1-555" },
      {},
      { status: "acknowledged" },
    )
    const apply = vi.spyOn(h.f.svc, "applyFilingSuccess")
    const timelineBefore = h.f.reports.timeline.get(f.reportId)?.length ?? 0

    const res = await call("recordManualFiling", {
      params: { id: f.id },
      body: { caseId: "1-556" },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(filingOf(res)).toMatchObject({
      status: "submitted",
      method: "operator",
      caseId: "1-556",
    })
    expect(apply).not.toHaveBeenCalled()
    expect(h.f.reports.timeline.get(f.reportId)?.length ?? 0).toBe(timelineBefore)
    expect(h.f.notifier.sent).toEqual([])
    expect(h.f.reports.reports.get(f.reportId)?.record.status).toBe("acknowledged")
  })

  it("T14: running is CONFLICT; a bad caseId or an http caseUrl is VALIDATION", async () => {
    const running = await filing({ status: "running", attempts: 1 })
    expectError(
      await call("recordManualFiling", { params: { id: running.id }, body: { caseId: "1-555" } }),
      409,
      "CONFLICT",
    )
    const queued = await filing({ status: "queued" })
    expectError(
      await call("recordManualFiling", { params: { id: queued.id }, body: { caseId: "<b>" } }),
      422,
      "VALIDATION",
    )
    expectError(
      await call("recordManualFiling", {
        params: { id: queued.id },
        body: { caseId: "1-555", caseUrl: "http://x.org" },
      }),
      422,
      "VALIDATION",
    )
  })
})

describe("filing settings", () => {
  it("T15: resuming runs one sweep pass that queues 100 email filings, oldest first", async () => {
    const created: string[] = []
    for (let i = 0; i < 120; i += 1) {
      created.push((await filing({}, { status: "queued" })).id)
    }
    h.f.filings.settings = { ...h.f.filings.settings, paused: true }
    const sweep = vi.spyOn(h.f.svc, "runSweepPass")

    const res = await call("setFilingSettings", { body: { paused: false } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ paused: false, automaticFiling: false })
    expect(sweep).toHaveBeenCalledTimes(1)
    expect(sweep).toHaveBeenCalledWith({ ignoreAge: true })
    const jobs = h.f.jobs.enqueued.filter((j) => j.name === FILING_EMAIL_JOB)
    expect(jobs.map((j) => (j.data as { filingId: string }).filingId)).toEqual(
      created.slice(0, 100),
    )
  })

  it("T16: setting the value it already has runs no pass and writes no audit", async () => {
    const sweep = vi.spyOn(h.f.svc, "runSweepPass")
    const res = await call("setFilingSettings", { body: { paused: false } })
    expect(res.statusCode, res.body).toBe(200)
    expect(sweep).not.toHaveBeenCalled()
    expect(h.f.filings.audits).toEqual([])
  })
})

describe("filing routes", () => {
  async function seedRoutes(): Promise<unknown> {
    await h.f.filings.replaceRoutes(J_GEOID, [{ category: null, channel: "email" }])
    return structuredClone(h.f.filings.routes)
  }

  function save(routes: unknown[]): Promise<LightMyRequestResponse> {
    return call("saveFilingRoutes", { params: { geoid: J_GEOID }, body: { routes } })
  }

  it("T17: an http or IP formUrl, a ninth row or two defaults is VALIDATION", async () => {
    const before = await seedRoutes()
    const categories = [...ReportCategorySchema.options, null]
    const nine = [...categories, "trash"].map((c) => emailRoute(c))
    expect(nine).toHaveLength(9)
    for (const routes of [
      [portalRoute("http://myla311.lacity.gov/s/")],
      nine,
      [portalRoute("https://127.0.0.1/")],
      [emailRoute(null), emailRoute(null)],
    ]) {
      expectError(await save(routes), 422, "VALIDATION")
    }
    expect(h.f.filings.routes).toEqual(before)
  })

  it("T18: a consumer mail sender domain is VALIDATION", async () => {
    const before = await seedRoutes()
    for (const domains of [["gmail.com"], ["mail.yahoo.com"]]) {
      expectError(
        await save([{ ...emailRoute(), statusSenderDomains: domains }]),
        422,
        "VALIDATION",
      )
    }
    expect(h.f.filings.routes).toEqual(before)
  })

  it("T19: saved routes list back with empty health", async () => {
    const saved = await save([emailRoute(null), portalRoute(PORTAL_URL, "graffiti")])
    expect(saved.statusCode, saved.body).toBe(200)

    const res = await call("listFilingRoutes", { params: { geoid: J_GEOID } })
    expect(res.statusCode, res.body).toBe(200)
    const { routes } = res.json<{ routes: { category: string | null; health: unknown }[] }>()
    expect(routes).toHaveLength(2)
    for (const route of routes) {
      expect(route.health).toEqual({ lastFiledAt: null, lastFailedAt: null, scriptVersion: null })
    }
  })

  it("T20: an unknown geoid is NOT_FOUND", async () => {
    expectError(await call("listFilingRoutes", { params: { geoid: "9999999" } }), 404, "NOT_FOUND")
  })

  it("names the refused sender domain's row and field", async () => {
    const res = await save([
      emailRoute(null),
      { ...emailRoute("graffiti"), statusSenderDomains: ["lacity.org", "gmail.com"] },
    ])
    expectError(res, 422, "VALIDATION")
    expect(JSON.stringify(res.json())).toContain("routes.1.statusSenderDomains")
  })
})

describe("guard and audit", () => {
  it("T21: a citizen session gets the admin guard's error on every endpoint", async () => {
    for (const name of FILING_ENDPOINTS) {
      const res = await call(name, {
        params: { id: UNKNOWN_ID, geoid: J_GEOID },
        ...(name === "listFilings" ? { query: { group: "needs_human" } } : {}),
        token: h.citizenToken,
      })
      expect(res.statusCode, `${name}: ${res.body}`).toBe(403)
      expect(res.json<{ code: string }>().code, name).toBe("FORBIDDEN")
    }
  })

  it("T22: each mutation writes one audit row through the repository", async () => {
    const audits = h.f.filings.audits
    async function expectOneAudit(
      send: () => Promise<LightMyRequestResponse>,
      expected: (res: LightMyRequestResponse) => Record<string, unknown>,
    ): Promise<void> {
      const before = audits.length
      const res = await send()
      expect(res.statusCode, res.body).toBe(200)
      expect(audits.slice(before)).toEqual([{ actorId: h.operatorId, ...expected(res) }])
    }

    const r = report()
    await expectOneAudit(
      () => call("fileReport", { params: { id: r } }),
      (res) => ({ action: "filing.filed", target: `filing:${filingOf(res).id}` }),
    )

    const retry = await filing({ status: "needs_human", reason: "no_route" })
    await expectOneAudit(
      () => call("retryFiling", { params: { id: retry.id } }),
      () => ({ action: "filing.retried", target: `filing:${retry.id}` }),
    )

    const cancel = await filing({ status: "queued" })
    await expectOneAudit(
      () => call("cancelFiling", { params: { id: cancel.id }, body: { note: "duplicate" } }),
      () => ({
        action: "filing.cancelled",
        target: `filing:${cancel.id}`,
        meta: { note: "duplicate" },
      }),
    )

    const manual = await filing({ status: "queued" })
    await expectOneAudit(
      () =>
        call("recordManualFiling", {
          params: { id: manual.id },
          body: { caseId: "1-555", note: "phoned it in" },
        }),
      () => ({
        action: "filing.manual_recorded",
        target: `filing:${manual.id}`,
        meta: { note: "phoned it in" },
      }),
    )

    await expectOneAudit(
      () => call("setFilingSettings", { body: { paused: true } }),
      () => ({
        action: "filing.settings_changed",
        target: "filing_settings",
        meta: { paused: true },
      }),
    )

    await expectOneAudit(
      () =>
        call("saveFilingRoutes", { params: { geoid: J_GEOID }, body: { routes: [emailRoute()] } }),
      () => ({
        action: "filing.routes_saved",
        target: `jurisdiction:${J_GEOID}`,
        meta: { count: 1 },
      }),
    )
  })

  it("T23: the Home summary counts needs_human filings", async () => {
    for (let i = 0; i < 3; i += 1) await filing({ status: "needs_human", reason: "no_route" })
    await filing({ status: "queued" })
    const res = await call("adminHomeSummary")
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json<{ filingsNeedsHuman: number }>().filingsNeedsHuman).toBe(3)
  })
})
