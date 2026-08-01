import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryModerationRepository } from "../../src/services/admin/moderation-repository.memory.js"
import type { ContentSubjectGate } from "../../src/services/content-report-subject.js"
import { AppError } from "@civfix/shared"

/**
 * Offline HTTP test for the PUBLIC content-report route (POST /content-reports). The route builds the
 * moderation service from the injected in-memory ModerationRepository (the SAME app.moderationOverrides
 * seam the admin queue uses), so the whole flow runs with no DB: a signed-in user files a report and an
 * OPEN `user_report` moderation item is enqueued (deduped by subject).
 */

let current: FastifyInstance | undefined

afterEach(async () => {
  if (current) {
    await current.close()
    current = undefined
  }
})

const SUBJECT = "22222222-2222-2222-2222-222222222222"

async function harness(gate?: ContentSubjectGate): Promise<{
  app: FastifyInstance
  mailer: FakeMailer
  repo: InMemoryModerationRepository
}> {
  const env = loadEnv({ NODE_ENV: "test" })
  const stores = makeInMemoryStores()
  const cache = new InMemoryCacheClient(() => Date.now())
  const mailer = new FakeMailer()
  const authServices = buildAuthServices({
    stores,
    cache,
    mailer,
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  const repo = new InMemoryModerationRepository()
  const app = await buildServer({
    env,
    authServices,
    moderationOverrides: { repo },
    ...(gate ? { contentSubjectGate: gate } : {}),
  })
  current = app
  return { app, mailer, repo }
}

function denyGate(hidden: ReadonlySet<string>): ContentSubjectGate {
  return {
    assertReportable(_subjectType, subjectId): Promise<void> {
      if (hidden.has(subjectId)) throw AppError.notFound("Content not found")
      return Promise.resolve()
    },
  }
}

async function signIn(
  app: FastifyInstance,
  mailer: FakeMailer,
  email: string,
): Promise<{ token: string; userId: string }> {
  await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
  const code = mailer.lastOtpFor(email)!
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "mobile" },
    payload: { email, code },
  })
  const body = verify.json()
  return { token: body.token, userId: body.user.id }
}

describe("POST /content-reports", () => {
  it("enqueues a user_report moderation item for the reported subject", async () => {
    const { app, mailer, repo } = await harness()
    const { token, userId } = await signIn(app, mailer, "reporter@example.com")

    const res = await app.inject({
      method: "POST",
      url: "/v1/content-reports",
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
      payload: {
        subjectType: "comment",
        subjectId: SUBJECT,
        reason: "harassment",
        details: "This comment is abusive.",
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    const items = [...repo.items.values()]
    expect(items).toHaveLength(1)
    const item = items[0]!
    expect(item.kind).toBe("user_report")
    expect(item.subjectType).toBe("comment")
    expect(item.subjectId).toBe(SUBJECT)
    expect(item.reason).toBe("harassment")
    expect(item.status).toBe("open")
    expect(item.desc).toBe("This comment is abusive.")
    // reporterId is threaded end-to-end from the authed FLAGGING user (not the flagged subject's author).
    expect(item.reporterId).toBe(userId)
  })

  // A feed post was the only UGC in civfix with no report path: ContentReportSubject had no "post"
  // member, so the request 400'd at the schema boundary before it ever reached the queue.
  it("accepts a POST subject and files it under its own subject type", async () => {
    const { app, mailer, repo } = await harness()
    const { token } = await signIn(app, mailer, "reporter@example.com")

    const res = await app.inject({
      method: "POST",
      url: "/v1/content-reports",
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
      payload: { subjectType: "post", subjectId: SUBJECT, reason: "harassment" },
    })

    expect(res.statusCode).toBe(200)
    const item = [...repo.items.values()][0]!
    expect(item.kind).toBe("user_report")
    // NOT folded into "comment": the queue resolves a subject's author and its takedown target per type,
    // so a post filed as a comment would resolve to no author and could not be removed.
    expect(item.subjectType).toBe("post")
    expect(item.subjectId).toBe(SUBJECT)
  })

  it("dedupes a second open report against the same subject (one queue item)", async () => {
    const { app, mailer, repo } = await harness()
    const { token } = await signIn(app, mailer, "reporter@example.com")

    const file = () =>
      app.inject({
        method: "POST",
        url: "/v1/content-reports",
        headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
        payload: { subjectType: "photo", subjectId: SUBJECT, reason: "sexual" },
      })

    expect((await file()).statusCode).toBe(200)
    expect((await file()).statusCode).toBe(200)

    expect([...repo.items.values()]).toHaveLength(1)
  })

  it("files a report-subject content report (owner check degrades to false with no DB)", async () => {
    // With no DATABASE_URL (all-fakes harness), reportOwnedBy() short-circuits to false, so a `report`
    // subject is filed as an ordinary user_report (flag "User report"), never crashing on a DB query.
    const { app, mailer, repo } = await harness()
    const { token } = await signIn(app, mailer, "reporter@example.com")

    const res = await app.inject({
      method: "POST",
      url: "/v1/content-reports",
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
      payload: { subjectType: "report", subjectId: SUBJECT, reason: "other", details: "remove please" },
    })

    expect(res.statusCode).toBe(200)
    const item = [...repo.items.values()][0]!
    expect(item.kind).toBe("user_report")
    expect(item.subjectType).toBe("report")
    expect(item.flag).toBe("User report")
    expect(item.priority).toBe("med")
  })

  it("404s when the subject gate rejects an invisible or nonexistent subject", async () => {
    const { app, mailer, repo } = await harness(denyGate(new Set([SUBJECT])))
    const { token } = await signIn(app, mailer, "reporter@example.com")

    const res = await app.inject({
      method: "POST",
      url: "/v1/content-reports",
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
      payload: { subjectType: "message", subjectId: SUBJECT, reason: "harassment" },
    })

    expect(res.statusCode).toBe(404)
    expect([...repo.items.values()]).toHaveLength(0)
  })

  it("enqueues once when the gate allows the subject", async () => {
    const { app, mailer, repo } = await harness(denyGate(new Set()))
    const { token } = await signIn(app, mailer, "reporter@example.com")

    const res = await app.inject({
      method: "POST",
      url: "/v1/content-reports",
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
      payload: { subjectType: "post", subjectId: SUBJECT, reason: "spam" },
    })

    expect(res.statusCode).toBe(200)
    expect([...repo.items.values()]).toHaveLength(1)
  })

  it("401s an unauthenticated report", async () => {
    const { app } = await harness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/content-reports",
      headers: { "x-client": "mobile" },
      payload: { subjectType: "report", subjectId: SUBJECT, reason: "spam" },
    })
    expect(res.statusCode).toBe(401)
  })
})
