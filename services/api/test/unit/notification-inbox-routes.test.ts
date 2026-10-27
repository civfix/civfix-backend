import { afterEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { LightMyRequestResponse } from "fastify"
import type { NotificationType } from "@civfix/contract"
import type { FakePushSender, FakeUserChannel } from "@civfix/seams"
import type { NotificationRecord } from "../../src/services/notification-repository.js"
import { makeAuthHarness, type AuthHarness } from "../helpers/auth.js"
import {
  InMemoryNotificationRepository,
  InMemoryNotificationSettingsRepository,
} from "../helpers/notifications.js"

/**
 * The inbox endpoints (unread, read, read-all, dismiss) and the web push config, through the real Fastify
 * app over the in-memory notification repository. `push.clears` is the seams' FakePushSender record of
 * every `clear`, and `channel.published` the FakeUserChannel record of every signal. The SQL side runs
 * against PostGIS in test/integration/notification-inbox-pg.test.ts.
 *
 * A and B are signed in over cookie sessions; requests carry the CSRF token unless a case says otherwise.
 */

interface WebSession {
  userId: string
  cookie: string
  csrfToken: string
}

interface LogLine {
  level: number
  msg?: string
  [key: string]: unknown
}

interface Harness {
  auth: AuthHarness
  repo: InMemoryNotificationRepository
  push: FakePushSender
  channel: FakeUserChannel
  logs: LogLine[]
  a: WebSession
  b: WebSession
}

const WARN = 40

const NOTIFICATIONS_SIGNAL = { topic: "notifications" }

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

async function makeHarness(env: Record<string, string> = {}): Promise<Harness> {
  if (current) {
    await current.app.close()
    current = undefined
  }
  const repo = new InMemoryNotificationRepository()
  const logs: LogLine[] = []
  const auth = await makeAuthHarness({
    env,
    server: {
      notificationOverrides: { repo, settingsRepo: new InMemoryNotificationSettingsRepository() },
      logCapture: {
        level: "warn",
        stream: { write: (line: string) => logs.push(JSON.parse(line) as LogLine) },
      },
    },
  })
  current = auth
  const a = await signInWeb(auth, "a@example.com")
  const b = await signInWeb(auth, "b@example.com")
  return {
    auth,
    repo,
    // Read on use: with USE_FAKE_PUSH off, touching the sender would build the real one.
    get push() {
      return auth.container.pushSender as FakePushSender
    },
    channel: auth.container.userChannel as FakeUserChannel,
    logs,
    a,
    b,
  }
}

function withCsrf(s: WebSession): Record<string, string> {
  return { cookie: s.cookie, "x-csrf-token": s.csrfToken }
}

function noCsrf(s: WebSession): Record<string, string> {
  return { cookie: s.cookie }
}

function unread(h: Harness, headers?: Record<string, string>): Promise<LightMyRequestResponse> {
  return h.auth.app.inject({
    method: "GET",
    url: "/v1/notifications/unread",
    ...(headers ? { headers } : {}),
  })
}

function readAll(h: Harness, headers?: Record<string, string>): Promise<LightMyRequestResponse> {
  return h.auth.app.inject({
    method: "POST",
    url: "/v1/notifications/read-all",
    ...(headers ? { headers } : {}),
  })
}

function dismiss(
  h: Harness,
  id: string,
  headers?: Record<string, string>,
): Promise<LightMyRequestResponse> {
  return h.auth.app.inject({
    method: "DELETE",
    url: `/v1/notifications/${id}`,
    ...(headers ? { headers } : {}),
  })
}

function markRead(
  h: Harness,
  ids: string[],
  headers?: Record<string, string>,
): Promise<LightMyRequestResponse> {
  return h.auth.app.inject({
    method: "POST",
    url: "/v1/notifications/read",
    payload: { ids },
    ...(headers ? { headers } : {}),
  })
}

function webConfig(h: Harness, headers?: Record<string, string>): Promise<LightMyRequestResponse> {
  return h.auth.app.inject({
    method: "GET",
    url: "/v1/push/web-config",
    ...(headers ? { headers } : {}),
  })
}

async function row(
  h: Harness,
  userId: string,
  type: NotificationType,
  opts: { readAt?: Date; link?: string } = {},
): Promise<NotificationRecord> {
  const record = await h.repo.insertNotification({
    userId,
    type,
    title: type,
    body: null,
    link: opts.link ?? null,
  })
  if (opts.readAt) record.readAt = opts.readAt
  return record
}

function byId(h: Harness, id: string): NotificationRecord | undefined {
  return h.repo.notifications.find((n) => n.id === id)
}

function signalsTo(h: Harness, userId: string) {
  return h.channel.published.filter((p) => p.userId === userId)
}

// The test-only contract response check is an async onSend hook, so a handler that sends without
// returning the reply makes fastify warn about a second send; that notice is the harness's, not the route's.
const FASTIFY_SECOND_SEND = "Reply was already sent"

function warnings(h: Harness): LogLine[] {
  return h.logs.filter((l) => l.level === WARN && !l.msg?.startsWith(FASTIFY_SECOND_SEND))
}

const R = new Date("2026-10-01T12:00:00.000Z")

describe("GET /v1/notifications/unread", () => {
  it("T1: no session is 401", async () => {
    const h = await makeHarness()
    const res = await unread(h)
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe("UNAUTHORIZED")
  })

  it("T2: no notifications is false", async () => {
    const h = await makeHarness()
    const res = await unread(h, noCsrf(h.a))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ hasUnread: false })
  })

  it("T3: one unread new_follower is true", async () => {
    const h = await makeHarness()
    await row(h, h.a.userId, "new_follower")
    const res = await unread(h, noCsrf(h.a))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ hasUnread: true })
  })

  it("T4: unread chat rows alone are false", async () => {
    const h = await makeHarness()
    for (const type of ["dm", "cleanup_chat", "group_chat", "report_chat"] as const) {
      await row(h, h.a.userId, type)
    }
    const res = await unread(h, noCsrf(h.a))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ hasUnread: false })
  })

  it("T5: a read row of A and an unread row of B are false for A", async () => {
    const h = await makeHarness()
    await row(h, h.a.userId, "post_like", { readAt: R })
    await row(h, h.b.userId, "post_like")
    const res = await unread(h, noCsrf(h.a))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ hasUnread: false })
  })

  it("T6: an unread chat_mention is true", async () => {
    const h = await makeHarness()
    await row(h, h.a.userId, "chat_mention")
    const res = await unread(h, noCsrf(h.a))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ hasUnread: true })
  })

  it("T7: a cookie session without CSRF is served", async () => {
    const h = await makeHarness()
    const res = await unread(h, noCsrf(h.a))
    expect(res.statusCode).toBe(200)
  })
})

describe("POST /v1/notifications/read-all", () => {
  it("T10: no session is 401", async () => {
    const h = await makeHarness()
    const res = await readAll(h)
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe("UNAUTHORIZED")
  })

  it("T11: a cookie session without CSRF is 403 and changes nothing", async () => {
    const h = await makeHarness()
    const n = await row(h, h.a.userId, "new_follower")
    const res = await readAll(h, noCsrf(h.a))
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe("FORBIDDEN")
    expect(byId(h, n.id)!.readAt).toBeNull()
    expect(h.push.clears).toHaveLength(0)
    expect(h.channel.published).toHaveLength(0)
  })

  it("T12: marks A's unread page rows read, clears all and signals A once", async () => {
    const h = await makeHarness()
    const follower = await row(h, h.a.userId, "new_follower")
    const like = await row(h, h.a.userId, "post_like")
    const mention = await row(h, h.a.userId, "chat_mention")
    const dm = await row(h, h.a.userId, "dm")
    const reply = await row(h, h.a.userId, "post_reply", { readAt: R })
    const others = await row(h, h.b.userId, "post_like")

    const res = await readAll(h, withCsrf(h.a))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    for (const n of [follower, like, mention]) expect(byId(h, n.id)!.readAt).not.toBeNull()
    expect(byId(h, dm.id)!.readAt).toBeNull()
    expect(byId(h, reply.id)!.readAt).toEqual(R)
    expect(byId(h, others.id)!.readAt).toBeNull()
    expect(h.push.clears).toEqual([{ userId: h.a.userId, target: { all: true } }])
    expect(h.channel.published).toEqual([{ userId: h.a.userId, signal: NOTIFICATIONS_SIGNAL }])
  })

  it("T13: only an unread dm changes nothing and sends nothing", async () => {
    const h = await makeHarness()
    const dm = await row(h, h.a.userId, "dm")
    const res = await readAll(h, withCsrf(h.a))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(byId(h, dm.id)!.readAt).toBeNull()
    expect(h.push.clears).toHaveLength(0)
    expect(h.channel.published).toHaveLength(0)
  })

  it("T14: 10 per minute per account", async () => {
    const h = await makeHarness()
    for (let i = 0; i < 10; i += 1) {
      expect((await readAll(h, withCsrf(h.a))).statusCode, `request ${i + 1}`).toBe(200)
    }
    const over = await readAll(h, withCsrf(h.a))
    expect(over.statusCode).toBe(429)
    expect(over.json().code).toBe("RATE_LIMITED")
    expect((await readAll(h, withCsrf(h.b))).statusCode).toBe(200)
  })
})

describe("DELETE /v1/notifications/:id", () => {
  it("T17: no session is 401", async () => {
    const h = await makeHarness()
    const res = await dismiss(h, randomUUID())
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe("UNAUTHORIZED")
  })

  it("T18: a cookie session without CSRF is 403 and keeps the row", async () => {
    const h = await makeHarness()
    const n = await row(h, h.a.userId, "post_like")
    const res = await dismiss(h, n.id, noCsrf(h.a))
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe("FORBIDDEN")
    expect(byId(h, n.id)).toBeDefined()
    expect(h.push.clears).toHaveLength(0)
    expect(h.channel.published).toHaveLength(0)
  })

  it("T19: deletes A's unread row, clears its id and signals A once", async () => {
    const h = await makeHarness()
    const n = await row(h, h.a.userId, "post_like")
    const res = await dismiss(h, n.id, withCsrf(h.a))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    const list = await h.auth.app.inject({
      method: "GET",
      url: "/v1/notifications",
      headers: noCsrf(h.a),
    })
    expect(list.json().items.map((i: { id: string }) => i.id)).not.toContain(n.id)
    expect(h.push.clears).toEqual([{ userId: h.a.userId, target: { ids: [n.id] } }])
    expect(h.channel.published).toEqual([{ userId: h.a.userId, signal: NOTIFICATIONS_SIGNAL }])
  })

  it("T20: deletes A's read row too", async () => {
    const h = await makeHarness()
    const n = await row(h, h.a.userId, "new_follower", { readAt: R })
    const res = await dismiss(h, n.id, withCsrf(h.a))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(byId(h, n.id)).toBeUndefined()
    expect(h.push.clears).toEqual([{ userId: h.a.userId, target: { ids: [n.id] } }])
    expect(h.channel.published).toHaveLength(1)
  })

  it("T21: an unknown id is NOT_FOUND", async () => {
    const h = await makeHarness()
    const res = await dismiss(h, randomUUID(), withCsrf(h.a))
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe("NOT_FOUND")
    expect(h.push.clears).toHaveLength(0)
    expect(h.channel.published).toHaveLength(0)
  })

  it("T22: someone else's id is the same NOT_FOUND and keeps their row", async () => {
    const h = await makeHarness()
    const m = await row(h, h.b.userId, "post_like")
    const unknown = await dismiss(h, randomUUID(), withCsrf(h.a))
    const foreign = await dismiss(h, m.id, withCsrf(h.a))
    expect(foreign.statusCode).toBe(404)
    expect(foreign.json().code).toBe("NOT_FOUND")
    // Every error body carries its own requestId; apart from it the two must match byte for byte.
    const withoutRequestId = (res: LightMyRequestResponse) =>
      res.body.replace(res.json<{ requestId: string }>().requestId, "")
    expect(withoutRequestId(foreign)).toBe(withoutRequestId(unknown))
    expect(byId(h, m.id)!.readAt).toBeNull()
    expect(h.push.clears).toHaveLength(0)
    expect(signalsTo(h, h.a.userId)).toHaveLength(0)
    expect(signalsTo(h, h.b.userId)).toHaveLength(0)
  })

  it("T23: a malformed id is a validation error", async () => {
    const h = await makeHarness()
    const n = await row(h, h.a.userId, "post_like")
    const res = await dismiss(h, "not-a-uuid", withCsrf(h.a))
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
    expect(byId(h, n.id)).toBeDefined()
    expect(h.repo.notifications).toHaveLength(1)
  })

  it("T24: dismissing twice is 200 then NOT_FOUND, with one clear", async () => {
    const h = await makeHarness()
    const n = await row(h, h.a.userId, "post_like")
    const first = await dismiss(h, n.id, withCsrf(h.a))
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ ok: true })
    const second = await dismiss(h, n.id, withCsrf(h.a))
    expect(second.statusCode).toBe(404)
    expect(second.json().code).toBe("NOT_FOUND")
    expect(h.push.clears).toHaveLength(1)
  })

  it("T25: 120 per minute per account", async () => {
    const h = await makeHarness()
    for (let i = 0; i < 120; i += 1) {
      expect(
        (await dismiss(h, randomUUID(), withCsrf(h.a))).statusCode,
        `request ${i + 1}`,
      ).not.toBe(429)
    }
    const over = await dismiss(h, randomUUID(), withCsrf(h.a))
    expect(over.statusCode).toBe(429)
    expect(over.json().code).toBe("RATE_LIMITED")
  })
})

describe("POST /v1/notifications/read", () => {
  it("T27: marks only A's unread ids, clears those and signals A once", async () => {
    const h = await makeHarness()
    const a = await row(h, h.a.userId, "new_follower")
    const b = await row(h, h.a.userId, "post_like", { readAt: R })
    const c = await row(h, h.b.userId, "post_like")
    const res = await markRead(h, [a.id, b.id, c.id], withCsrf(h.a))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(byId(h, a.id)!.readAt).not.toBeNull()
    expect(byId(h, b.id)!.readAt).toEqual(R)
    expect(byId(h, c.id)!.readAt).toBeNull()
    expect(h.push.clears).toEqual([{ userId: h.a.userId, target: { ids: [a.id] } }])
    expect(h.channel.published).toEqual([{ userId: h.a.userId, signal: NOTIFICATIONS_SIGNAL }])
  })

  it("T28: nothing of A's unread sends nothing", async () => {
    const h = await makeHarness()
    const b = await row(h, h.a.userId, "post_like", { readAt: R })
    const c = await row(h, h.b.userId, "post_like")
    const res = await markRead(h, [b.id, c.id], withCsrf(h.a))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(h.push.clears).toHaveLength(0)
    expect(h.channel.published).toHaveLength(0)
  })

  it("T29: no ids sends nothing", async () => {
    const h = await makeHarness()
    const res = await markRead(h, [], withCsrf(h.a))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(h.push.clears).toHaveLength(0)
    expect(h.channel.published).toHaveLength(0)
  })

  it("T30: a chat row read by id is cleared by id", async () => {
    const h = await makeHarness()
    const d = await row(h, h.a.userId, "dm")
    const res = await markRead(h, [d.id], withCsrf(h.a))
    expect(res.statusCode).toBe(200)
    expect(byId(h, d.id)!.readAt).not.toBeNull()
    expect(h.push.clears).toEqual([{ userId: h.a.userId, target: { ids: [d.id] } }])
  })

  it("T31: 60 per minute per account", async () => {
    const h = await makeHarness()
    for (let i = 0; i < 60; i += 1) {
      expect((await markRead(h, [], withCsrf(h.a))).statusCode, `request ${i + 1}`).toBe(200)
    }
    const over = await markRead(h, [], withCsrf(h.a))
    expect(over.statusCode).toBe(429)
    expect(over.json().code).toBe("RATE_LIMITED")
  })
})

describe("a clear that fails", () => {
  it("T37: read, read-all and dismiss still succeed, persist and warn once each", async () => {
    const h = await makeHarness()
    h.push.clear = () => Promise.reject(new Error("redis down"))
    // The boot writes its own warnings (CORS, home-turf), so each action is measured from here.
    let seen = warnings(h).length
    const newWarnings = () => {
      const fresh = warnings(h).length - seen
      seen = warnings(h).length
      return fresh
    }

    const a = await row(h, h.a.userId, "new_follower")
    const read = await markRead(h, [a.id], withCsrf(h.a))
    expect(read.statusCode).toBe(200)
    expect(read.json()).toEqual({ ok: true })
    expect(byId(h, a.id)!.readAt).not.toBeNull()
    expect(newWarnings()).toBe(1)

    const like = await row(h, h.a.userId, "post_like")
    const all = await readAll(h, withCsrf(h.a))
    expect(all.statusCode).toBe(200)
    expect(all.json()).toEqual({ ok: true })
    expect(byId(h, like.id)!.readAt).not.toBeNull()
    expect(newWarnings()).toBe(1)

    const n = await row(h, h.a.userId, "post_like")
    const gone = await dismiss(h, n.id, withCsrf(h.a))
    expect(gone.statusCode).toBe(200)
    expect(gone.json()).toEqual({ ok: true })
    expect(byId(h, n.id)).toBeUndefined()
    expect(newWarnings()).toBe(1)
  })
})

describe("GET /v1/push/web-config", () => {
  const VAPID = {
    VAPID_PUBLIC_KEY: "BPubKeyTest",
    VAPID_PRIVATE_KEY: "private-key-test",
    VAPID_SUBJECT: "mailto:ops@example.org",
  }

  it("T38: no session is 401", async () => {
    const h = await makeHarness()
    const res = await webConfig(h)
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe("UNAUTHORIZED")
  })

  it("T39: real push with all three VAPID variables serves the public key", async () => {
    const h = await makeHarness({ USE_FAKE_PUSH: "false", ...VAPID })
    const res = await webConfig(h, noCsrf(h.a))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ vapidPublicKey: "BPubKeyTest" })
  })

  it("T40: any VAPID variable missing is null", async () => {
    for (const missing of Object.keys(VAPID)) {
      const env = Object.fromEntries(
        Object.entries({ USE_FAKE_PUSH: "false", ...VAPID }).filter(([key]) => key !== missing),
      )
      const h = await makeHarness(env)
      const res = await webConfig(h, noCsrf(h.a))
      expect(res.statusCode, missing).toBe(200)
      expect(res.json(), missing).toEqual({ vapidPublicKey: null })
    }
  })

  it("T41: the fake push sender is null", async () => {
    const h = await makeHarness({ USE_FAKE_PUSH: "true", ...VAPID })
    const res = await webConfig(h, noCsrf(h.a))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ vapidPublicKey: null })
  })

  it("T42: a cookie session without CSRF is served", async () => {
    const h = await makeHarness()
    const res = await webConfig(h, noCsrf(h.a))
    expect(res.statusCode).toBe(200)
  })
})
