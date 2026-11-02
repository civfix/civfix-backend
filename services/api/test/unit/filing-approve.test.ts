import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/seams"
import { makeServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { makeAuthServices } from "../../src/auth/auth-services.js"
import { makeOutboundMailService } from "../../src/services/admin/outbound-mail-service.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryMailRepository } from "../helpers/admin/mail-repository.memory.js"
import { filingHarness, J_CONTACT, type FilingHarness } from "../helpers/filings/filing-harness.js"

const OPERATOR = "ops@civfix.org"

interface World {
  app: FastifyInstance
  token: string
  h: FilingHarness
}

async function world(): Promise<World> {
  const stores = makeInMemoryStores()
  const services = makeAuthServices({
    stores,
    cache: new InMemoryCacheClient(() => Date.now()),
    mailer: new FakeMailer(),
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  const app = await makeServer({
    env: loadEnv({ NODE_ENV: "test", ADMIN_EMAILS: OPERATOR }),
    authServices: services,
  })
  const h = filingHarness()
  app.adminReportOverrides = {
    repo: h.reports,
    outboundMail: makeOutboundMailService({
      repo: new InMemoryMailRepository(),
      mailer: new FakeMailer(),
      env: { MAIL_FROM_OUTREACH: "outreach@civfix.org", MAIL_REPLY_DOMAIN: "civfix.org" },
    }),
    filings: h.svc,
    notifications: h.notifier,
  }
  const user = await stores.users.create(OPERATOR, {
    displayName: "Ops",
    role: "operator",
    emailVerified: true,
  })
  const token = await services.sessions.createSession(user.id, ["operator"])
  return { app, token, h }
}

let w: World
beforeEach(async () => {
  w = await world()
})
afterEach(async () => {
  await w.app.close()
})

function verdict(reportId: string, value: "approved" | "rejected") {
  return w.app.inject({
    method: "POST",
    url: `/v1/admin/reports/${reportId}/verdict`,
    headers: { authorization: `Bearer ${w.token}` },
    payload: { id: reportId, verdict: value },
  })
}

function filingsOf(reportId: string) {
  return [...w.h.filings.filings.values()].filter((f) => f.reportId === reportId)
}

describe("setReportVerdict: Approve and file", () => {
  it("E1: approving files the report: one queued email filing and one filing.email keyed by it", async () => {
    const r = w.h.seed({ contact: J_CONTACT })
    const res = await verdict(r.record.id, "approved")
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    const filings = filingsOf(r.record.id)
    expect(filings).toHaveLength(1)
    expect(filings[0]).toMatchObject({ status: "queued", channel: "email" })
    expect(w.h.jobs.jobsFor("filing.email").map((j) => ({ data: j.data, opts: j.opts }))).toEqual([
      { data: { filingId: filings[0]?.id }, opts: { singletonKey: filings[0]?.id } },
    ])
  })

  it("E2: approving twice creates one filing and one job", async () => {
    const r = w.h.seed({ contact: J_CONTACT })
    expect((await verdict(r.record.id, "approved")).json()).toEqual({ ok: true })
    expect((await verdict(r.record.id, "approved")).json()).toEqual({ ok: true })
    expect(filingsOf(r.record.id)).toHaveLength(1)
    expect(w.h.jobs.jobsFor("filing.email")).toHaveLength(1)
  })

  it("E3: rejecting a report with a queued filing cancels it", async () => {
    const r = w.h.seed({ contact: J_CONTACT })
    const created = await w.h.svc.create({ reportId: r.record.id, actorId: "op-1" })
    expect(created.kind).toBe("created")
    const res = await verdict(r.record.id, "rejected")
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(filingsOf(r.record.id).map((f) => f.status)).toEqual(["cancelled"])
  })
})
