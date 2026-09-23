import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer, FakeStorage } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { RecordingNotifier } from "../helpers/notifications.js"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryAdminReportRepository } from "../../src/services/admin/admin-report-repository.memory.js"
import { makeOutboundMailService } from "../../src/services/admin/outbound-mail-service.js"

const OPERATOR = "ops@civfix.org"

let app: FastifyInstance | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

async function makeHarness() {
  const stores = makeInMemoryStores()
  const services = buildAuthServices({
    stores,
    cache: new InMemoryCacheClient(() => Date.now()),
    mailer: new FakeMailer(),
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  app = await buildServer({
    env: loadEnv({ NODE_ENV: "test", ADMIN_EMAILS: OPERATOR }),
    authServices: services,
  })
  const repo = new InMemoryMailRepository()
  const reports = new InMemoryAdminReportRepository()
  reports.seedReport({ id: "report-1", status: "published", reporter: null })
  const emitted: unknown[] = []
  app.adminMailOverrides = {
    repo,
    outboundMail: makeOutboundMailService({
      repo,
      mailer: new FakeMailer(),
      env: { MAIL_FROM_OUTREACH: "outreach@civfix.org", MAIL_REPLY_DOMAIN: "civfix.org" },
    }),
    storage: new FakeStorage(),
    inboundEffects: {
      reportRepo: reports,
      notifications: new RecordingNotifier(),
      chatEmitter: {
        emit: (event) => {
          emitted.push(event)
          return Promise.resolve()
        },
      },
    },
  }
  const operator = await stores.users.create(OPERATOR, {
    displayName: "Ops",
    role: "operator",
    emailVerified: true,
  })
  const citizen = await stores.users.create("neighbor@example.com", {
    displayName: "Neighbor",
    role: "citizen",
    emailVerified: true,
  })
  const thread = repo.seedThread({ reportId: "report-1", status: "needs_action" })
  const message = repo.seedMessage({
    threadId: thread.id,
    direction: "in",
    fromAddr: "clerk@vendor.example",
    body: "Crew scheduled for Friday.",
    unaffiliated: true,
  })
  return {
    server: app,
    repo,
    emitted,
    operatorId: operator.id,
    token: await services.sessions.createSession(operator.id, ["operator"]),
    citizenToken: await services.sessions.createSession(citizen.id, ["citizen"]),
    thread,
    message,
  }
}

type Harness = Awaited<ReturnType<typeof makeHarness>>

function publish(h: Harness, threadId: string, messageId: string, token: string | null = h.token) {
  return h.server.inject({
    method: "POST",
    url: `/v1/admin/mail/${threadId}/messages/${messageId}/publish`,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload: {},
  })
}

describe("POST /admin/mail/:id/messages/:messageId/publish", () => {
  it("publishes a withheld reply once, audited with the acting operator", async () => {
    const h = await makeHarness()

    const res = await publish(h, h.thread.id, h.message.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ publication: "published" })
    expect(h.emitted).toHaveLength(1)
    expect(h.repo.audits).toMatchObject([
      { actorId: h.operatorId, action: "mail.reply_published", target: `mail:${h.thread.id}` },
    ])

    const again = await publish(h, h.thread.id, h.message.id)
    expect(again.json()).toEqual({ publication: "published" })
    expect([h.repo.audits.length, h.emitted.length]).toEqual([1, 1])
  })

  it("answers 422 for a malformed id, 404 off the thread and 409 for an unlinked thread", async () => {
    const h = await makeHarness()
    const other = h.repo.seedThread({})
    const loose = h.repo.seedMessage({ threadId: other.id, direction: "in", unaffiliated: true })

    expect((await publish(h, h.thread.id, "not-a-uuid")).statusCode).toBe(422)
    expect((await publish(h, other.id, h.message.id)).statusCode).toBe(404)
    const unlinked = await publish(h, other.id, loose.id)
    expect(unlinked.statusCode).toBe(409)
    expect(unlinked.json()).toMatchObject({ code: "CONFLICT" })
  })

  it("refuses anonymous, citizen and CSRF-less cookie callers without touching the reply", async () => {
    const h = await makeHarness()

    expect((await publish(h, h.thread.id, h.message.id, null)).statusCode).toBe(401)
    expect((await publish(h, h.thread.id, h.message.id, h.citizenToken)).statusCode).toBe(403)
    const viaCookie = await h.server.inject({
      method: "POST",
      url: `/v1/admin/mail/${h.thread.id}/messages/${h.message.id}/publish`,
      headers: { cookie: `civfix_session=${h.token}` },
      payload: {},
    })
    expect(viaCookie.statusCode).toBe(403)
    expect(viaCookie.json()).toMatchObject({ message: "CSRF token missing or invalid." })
    expect(h.message.unaffiliated).toBe(true)
    expect(h.repo.audits).toHaveLength(0)
  })
})
