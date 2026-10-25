import { afterEach, describe, expect, it, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/seams"
import { makeServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { makeAuthServices } from "../../src/auth/auth-services.js"
import type { ReportServiceOverrides } from "../../src/routes/reports.routes.js"
import type { FilingRecord } from "../../src/services/filings/filing-types.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryReportRepository } from "../helpers/reports.js"
import { InMemoryFilingRepository } from "../helpers/filings/filing-repository.memory.js"

/**
 * ReportDTO.filing and gov through the report routes (D13), on the real Fastify app with the in-memory
 * report and filing repositories injected.
 */

const J_GEOID = "0644000"
const J_NAME = "Los Angeles"

interface Harness {
  app: FastifyInstance
  repo: InMemoryReportRepository
  filings: InMemoryFilingRepository
  token: string
  userId: string
}

let current: Harness | undefined

afterEach(async () => {
  await current?.app.close()
  current = undefined
})

async function makeHarness(): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test" })
  const mailer = new FakeMailer()
  const authServices = makeAuthServices({
    stores: makeInMemoryStores(),
    cache: new InMemoryCacheClient(() => Date.now()),
    mailer,
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  const repo = new InMemoryReportRepository()
  const filings = new InMemoryFilingRepository()
  filings.jurisdictions.set(J_GEOID, J_NAME)
  const reportOverrides: ReportServiceOverrides = {
    repo,
    filings,
    resolveJurisdictionGeoid: () => Promise.resolve(J_GEOID),
    presignMedia: (r2Key) => Promise.resolve({ url: `memory://${r2Key}` }),
  }
  const app = await makeServer({ env, authServices, reportOverrides })
  const email = "reporter@example.com"
  await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "mobile" },
    payload: { email, code: mailer.lastOtpFor(email)! },
  })
  const body = verify.json()
  current = { app, repo, filings, token: body.token, userId: body.user.id }
  return current
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

async function filed(
  h: Harness,
  reportId: string,
  patch: Partial<FilingRecord> & { geoid?: string | null } = {},
): Promise<FilingRecord> {
  const out = await h.filings.create({
    reportId,
    geoid: patch.geoid === undefined ? J_GEOID : patch.geoid,
    category: "trash",
    ticketText: "Overflowing bin",
    status: "cancelled",
  })
  if (out.kind !== "created") throw new Error("not created")
  const { jurisdictionName: _name, ...row } = {
    ...out.filing,
    status: "submitted" as const,
    method: "email" as const,
    submittedAt: new Date("2026-06-01T10:00:00.000Z"),
    ...patch,
  }
  h.filings.filings.set(row.id, row)
  return { ...row, jurisdictionName: null }
}

describe("ReportDTO.filing", () => {
  it("C27: GET /reports/:id sends the latest successful filing, with gov true exactly when there is one", async () => {
    const h = await makeHarness()

    const full = h.repo.seedReport({ status: "acknowledged" })
    await filed(h, full.id, {
      caseId: "1-234",
      caseUrl: "https://myla311.lacity.gov/s/case/1",
    })
    const withCase = (await h.app.inject({ method: "GET", url: `/v1/reports/${full.id}` })).json()
    expect(withCase.filing).toEqual({
      jurisdictionName: J_NAME,
      caseId: "1-234",
      caseUrl: "https://myla311.lacity.gov/s/case/1",
      filedAt: "2026-06-01T10:00:00.000Z",
      linkedExisting: false,
    })
    expect(withCase.gov).toBe(true)

    const bare = h.repo.seedReport({ status: "acknowledged" })
    await filed(h, bare.id)
    const noCase = (await h.app.inject({ method: "GET", url: `/v1/reports/${bare.id}` })).json()
    expect(noCase.filing).toMatchObject({ caseId: null, caseUrl: null })
    expect(noCase.gov).toBe(true)

    const unfiled = h.repo.seedReport({ status: "published" })
    const none = (await h.app.inject({ method: "GET", url: `/v1/reports/${unfiled.id}` })).json()
    expect(none.filing).toBeNull()
    expect(none.gov).toBe(false)

    const nowhere = h.repo.seedReport({ status: "acknowledged" })
    await filed(h, nowhere.id, { geoid: null, method: "operator" })
    const cityless = (
      await h.app.inject({ method: "GET", url: `/v1/reports/${nowhere.id}` })
    ).json()
    expect(cityless.filing).toMatchObject({ jurisdictionName: null })
    expect(cityless.gov).toBe(true)
  })

  it("C28: GET /reports (mine) loads the page's filings in one call", async () => {
    const h = await makeHarness()
    const [a, b, c] = [1, 2, 3].map(() => h.repo.seedReport({ reporterUserId: h.userId }))
    await filed(h, a!.id)
    await filed(h, b!.id)
    const spy = vi.spyOn(h.filings, "getLatestSuccessfulForReports")

    const res = await h.app.inject({ method: "GET", url: "/v1/reports", headers: auth(h.token) })
    expect(res.statusCode).toBe(200)
    expect(spy).toHaveBeenCalledTimes(1)
    const items = res.json().items as { id: string; gov: boolean }[]
    expect(items.filter((i) => i.gov).map((i) => i.id).sort()).toEqual([a!.id, b!.id].sort())
    expect(items.find((i) => i.id === c!.id)?.gov).toBe(false)
  })

  it("C40: a new report has no filing; resolve and unlist return the filing", async () => {
    const h = await makeHarness()
    const createdRes = await h.app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: auth(h.token),
      payload: {
        idempotencyKey: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        category: "trash",
        type: "dump",
        lat: 34.1,
        lng: -118.35,
        geomSource: "device",
        mediaUploadIds: [],
      },
    })
    expect(createdRes.statusCode).toBe(201)
    expect(createdRes.json()).toMatchObject({ filing: null, gov: false })

    const r = h.repo.seedReport({ reporterUserId: h.userId, status: "acknowledged" })
    await filed(h, r.id, { caseId: "1-5" })
    const resolved = await h.app.inject({
      method: "POST",
      url: `/v1/reports/${r.id}/resolve`,
      headers: auth(h.token),
      payload: { resolved: true },
    })
    expect(resolved.statusCode).toBe(200)
    expect(resolved.json()).toMatchObject({ filing: { caseId: "1-5" }, gov: true })

    const unlisted = await h.app.inject({
      method: "POST",
      url: `/v1/reports/${r.id}/unlist`,
      headers: auth(h.token),
      payload: { unlisted: true },
    })
    expect(unlisted.statusCode).toBe(200)
    expect(unlisted.json()).toMatchObject({ filing: { caseId: "1-5" }, gov: true })
  })
})
