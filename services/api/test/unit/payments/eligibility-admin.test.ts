import { describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { FakeJobs, FakeStorage } from "@civfix/shared/fakes"
import { makeErrorHandler, makeNotFoundHandler } from "../../../src/errors/http-mapper.js"
import type { Container } from "../../../src/di.js"
import { registerAdminPaymentsRoutes } from "../../../src/routes/admin/payments.routes.js"
import {
  makeMemoryEligibilityRepository,
  memoryEligibilityOrg,
  type MemoryEligibilityRepository,
} from "../../../src/services/payments/eligibility-repository.memory.js"
import { makeMemoryOrgPaymentsRepository } from "../../../src/services/payments/org-payments-repository.memory.js"
import { NOW, ORG_ID, accountRow, eligibilityRow, orgRow, settingsRow } from "./helpers.js"

const OPERATOR = "11111111-1111-1111-1111-111111111111"
const ORG_B = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb"
const UNKNOWN_ORG = "cccccccc-0000-4000-8000-cccccccccccc"

const PAYMENTS_ENV = {
  PAYMENTS_ENABLED: true,
  DONATION_PLATFORM_FEE_BPS: 500,
  DONATION_MIN_MINOR: 500,
  DONATION_MAX_MINOR: 1_000_000,
  ELIGIBILITY_STALE_GRACE_HOURS: 72,
  PAYMENT_METHOD_DOMAINS: ["civfix.org"],
  CA_CFP_REGISTRATION_NUMBER: "CFP-123456",
}

interface Harness {
  app: FastifyInstance
  eligibility: MemoryEligibilityRepository
  jobs: FakeJobs
  audits: unknown[][]
}

async function harness(): Promise<Harness> {
  const eligibility = makeMemoryEligibilityRepository({
    orgs: [
      memoryEligibilityOrg({ organizationId: ORG_ID }),
      memoryEligibilityOrg({ organizationId: ORG_B, name: "Second Org", slug: "second-org", paymentsState: "not_started" }),
    ],
    eligibility: [
      { organizationId: ORG_ID, ein: "954327245", einSource: "org_verification", verdict: "eligible" },
    ],
    checks: [
      {
        organizationId: ORG_ID,
        source: "irs_pub78",
        ein: "954327245",
        irsLegalName: "REACH OUT LOS ANGELES INC",
        foundationCode: null,
        deductibilityCode: "PC",
        sourceRevisionDate: "2026-05-20",
        rawReportSha256: null,
        rawReportKey: null,
        matched: true,
        verdictContribution: "supports",
        detail: null,
        checkedAt: NOW,
        retentionUntil: new Date("2033-06-01T00:00:00.000Z"),
      },
    ],
  })
  const orgs = makeMemoryOrgPaymentsRepository({
    orgs: [orgRow(), orgRow({ id: ORG_B, slug: "second-org", name: "Second Org" })],
    accounts: [accountRow()],
    settings: [settingsRow()],
    eligibility: [eligibilityRow()],
  })
  const jobs = new FakeJobs()
  const audits: unknown[][] = []
  const sql = Object.assign(
    (_strings: TemplateStringsArray, ...values: unknown[]) => {
      audits.push(values)
      return Promise.resolve([{ id: "audit-1" }])
    },
    { json: (value: unknown) => value },
  )

  const container = {
    env: { ...PAYMENTS_ENV, NODE_ENV: "test", WEB_ORIGINS: ["https://civfix.org"] },
    csrf: { protect: (_req: unknown, _reply: unknown, done: () => void) => done() },
    jobs,
    storage: new FakeStorage(),
    getDb: () => ({ sql }),
  } as unknown as Container

  const app = Fastify({ logger: false })
  app.setErrorHandler(makeErrorHandler())
  app.setNotFoundHandler(makeNotFoundHandler())
  const alwaysAllowed = () => () =>
    Promise.resolve({ isAllowed: true, isExceeded: false, max: 1, remaining: 1, ttlInSeconds: 0 })
  ;(app.decorate as (name: string, value: unknown) => void)("createRateLimit", alwaysAllowed)
  ;(app.decorateRequest as (name: string, value: unknown) => void)("auth", null)
  app.addHook("onRequest", (request, _reply, done) => {
    ;(request as { auth?: unknown }).auth = { userId: OPERATOR, roles: ["operator"] }
    done()
  })
  app.decorate("adminPaymentsOverrides", { orgs, eligibility, now: () => NOW })
  await registerAdminPaymentsRoutes(app, container)
  await app.ready()
  return { app, eligibility, jobs, audits }
}

describe("admin eligibility queue", () => {
  it("lists every verified nonprofit in one page query with its recent checks and counts", async () => {
    const h = await harness()
    const res = await h.app.inject({ method: "GET", url: "/v1/admin/payments/eligibility" })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      items: {
        organizationId: string
        paymentsState: string
        einSource: string | null
        eligibility: { verdict: string; einLast4: string | null; checks: { source: string }[] }
      }[]
      counts: { eligible: number; unknown: number }
    }
    expect(body.items).toHaveLength(2)
    const a = body.items.find((row) => row.organizationId === ORG_ID)
    expect(a).toMatchObject({ paymentsState: "ready", einSource: "org_verification" })
    expect(a?.eligibility).toMatchObject({ verdict: "eligible", einLast4: "7245" })
    expect(a?.eligibility.checks[0]?.source).toBe("irs_pub78")
    const b = body.items.find((row) => row.organizationId === ORG_B)
    expect(b?.eligibility.verdict).toBe("unknown")
    expect(body.counts).toMatchObject({ eligible: 1, unknown: 1 })
  })

  it("honours the verdict and state filters", async () => {
    const h = await harness()
    const byVerdict = await h.app.inject({ method: "GET", url: "/v1/admin/payments/eligibility?verdict=unknown" })
    expect((byVerdict.json() as { items: { organizationId: string }[] }).items.map((row) => row.organizationId)).toEqual([ORG_B])
    const byState = await h.app.inject({ method: "GET", url: "/v1/admin/payments/eligibility?state=ready" })
    expect((byState.json() as { items: { organizationId: string }[] }).items.map((row) => row.organizationId)).toEqual([ORG_ID])
  })
})

describe("admin eligibility actions", () => {
  it("sets an EIN with operator provenance, audits it and queues an evaluation", async () => {
    const h = await harness()
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/admin/orgs/${ORG_B}/payments/eligibility/ein`,
      payload: { ein: "12-3456789" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, einLast4: "6789" })
    expect(h.eligibility.eligibility.get(ORG_B)).toMatchObject({ ein: "123456789", einSource: "operator", einSetBy: OPERATOR })
    expect(h.jobs.enqueued[0]).toMatchObject({ name: "eligibility.evaluate", data: { organizationId: ORG_B } })
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0]?.[1]).toBe("org_payments.ein_set")
    expect(JSON.stringify(h.audits[0])).not.toContain("123456789")
  })

  it("rejects a malformed EIN and an unknown organization", async () => {
    const h = await harness()
    const bad = await h.app.inject({ method: "POST", url: `/v1/admin/orgs/${ORG_B}/payments/eligibility/ein`, payload: { ein: "12" } })
    expect(bad.statusCode).toBe(422)
    const missing = await h.app.inject({ method: "POST", url: `/v1/admin/orgs/${UNKNOWN_ORG}/payments/eligibility/ein`, payload: { ein: "11-1111111" } })
    expect(missing.statusCode).toBe(404)
  })

  it("records a central-organization confirmation as evidence and re-evaluates", async () => {
    const h = await harness()
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/admin/orgs/${ORG_ID}/payments/eligibility/central-org`,
      payload: { confirmed: true, note: "group ruling letter on file" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, centralOrgConfirmedAt: NOW.toISOString() })
    expect(h.eligibility.checks.at(-1)).toMatchObject({ source: "central_org_confirmation", matched: true, detail: "group ruling letter on file" })
    expect(h.jobs.enqueued[0]).toMatchObject({ name: "eligibility.evaluate", data: { organizationId: ORG_ID } })
    expect(h.audits[0]?.[1]).toBe("org_payments.central_org_confirmed")
  })

  it("queues an on-demand evaluation", async () => {
    const h = await harness()
    const res = await h.app.inject({ method: "POST", url: `/v1/admin/orgs/${ORG_ID}/payments/eligibility/evaluate`, payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, queued: true })
    expect(h.jobs.enqueued).toHaveLength(1)
  })

  it("exposes the review_required policy on the platform settings", async () => {
    const h = await harness()
    const res = await h.app.inject({ method: "GET", url: "/v1/admin/payments/settings" })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { reviewRequiredBlocks: boolean }).reviewRequiredBlocks).toBe(false)
  })
})
