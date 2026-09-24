/**
 * Tests for the shared offline auth harness itself (test/helpers/auth.ts): the OTP `signIn` primitive and
 * `makeAuthHarness`'s pass-through of buildServer overrides.
 *
 * ~10 unit suites each hand-rolled this sign-in and its server boot. Before those adopt the shared
 * versions, the shared versions need their own coverage: that the token really authenticates, that a
 * broken sign-in FAILS LOUDLY here instead of surfacing as a mystery 401 in the suite under test, and
 * that an injected repository/container actually reaches the app.
 */

import { describe, expect, it, afterEach, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import type { FakeChatService } from "@civfix/shared/fakes"
import { bearer, makeAuthHarness, signIn, type AuthHarness } from "./auth.js"
import { InMemoryNotificationRepository } from "./notifications.js"
import { buildContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"

let open: FastifyInstance | undefined

afterEach(async () => {
  await open?.close()
  open = undefined
})

async function harness(opts: Parameters<typeof makeAuthHarness>[0] = {}): Promise<AuthHarness> {
  const h = await makeAuthHarness(opts)
  open = h.app
  return h
}

describe("signIn (shared OTP sign-in)", () => {
  it("returns a bearer token that authenticates as the returned user", async () => {
    const h = await harness()
    const session = await signIn(h.app, h.mailer, "harness@example.com")

    expect(session.token).not.toBe("")
    expect(session.userId).toBe(session.user.id)

    const me = await h.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: bearer(session.token),
    })
    expect(me.statusCode).toBe(200)
    expect(me.json().authenticated).toBe(true)
    expect(me.json().user.id).toBe(session.userId)
  })

  it("is exposed pre-bound on the harness and signs the SAME account in twice", async () => {
    const h = await harness()
    const first = await h.signIn("repeat@example.com")
    // A second code for the same address is refused for 60s (the per-email cooldown in auth/otp.ts), so
    // a suite that signs one account in twice MUST advance the harness clock between them.
    h.advance(61_000)
    const second = await h.signIn("repeat@example.com")
    expect(second.userId).toBe(first.userId)
    // Each sign-in mints its own session, so the tokens must differ (and both must work).
    expect(second.token).not.toBe(first.token)
    for (const token of [first.token, second.token]) {
      const res = await h.app.inject({
        method: "GET",
        url: "/v1/auth/session",
        headers: bearer(token),
      })
      expect(res.json().authenticated).toBe(true)
    }
  })

  it("the session is NOT authenticated without the token (the assertion above is real)", async () => {
    const h = await harness()
    await h.signIn("anon-check@example.com")
    const res = await h.app.inject({ method: "GET", url: "/v1/auth/session" })
    expect(res.statusCode).toBe(200)
    expect(res.json().authenticated).toBe(false)
  })

  it("throws with the status + body when the OTP request is rejected", async () => {
    const h = await harness()
    // Not an email: POST /auth/otp/request answers 422, so there is no code to read. The hand-rolled
    // copies non-null-asserted past this and returned an undefined token.
    await expect(signIn(h.app, h.mailer, "not-an-email")).rejects.toThrow(
      /signIn\(not-an-email\): otp\/request 422/,
    )
  })

  it("throws when the code is consumed before verify (single-use OTP)", async () => {
    const h = await harness()
    const email = "consumed@example.com"
    await h.signIn(email)
    // The code just used is spent; replaying it through a fresh request-less verify must fail loudly.
    const code = h.mailer.lastOtpFor(email)
    const replay = await h.app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": "mobile" },
      payload: { email, code },
    })
    expect(replay.statusCode).toBe(401)
  })
})

describe("makeAuthHarness (buildServer override pass-through)", () => {
  it("passes route-service overrides to the app (the injected repo serves the request)", async () => {
    const repo = new InMemoryNotificationRepository()
    const h = await harness({ server: { notificationOverrides: { repo } } })
    const { token, userId } = await h.signIn("notif-harness@example.com")

    // Seeded straight into the injected repo: if the override had not reached buildServer, the route
    // would be reading the (absent) database instead.
    await repo.insertNotification({
      userId,
      type: "system",
      title: "from the injected repo",
      body: null,
      link: null,
    })

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/notifications",
      headers: bearer(token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().items.map((n: { title: string }) => n.title)).toEqual([
      "from the injected repo",
    ])
  })

  it("exposes the container it built, with the test fakes wired", async () => {
    const h = await harness()
    expect(h.container.env.NODE_ENV).toBe("test")
    // USE_FAKE_CHAT is on for the test env, so the chat seam is the in-memory fake a suite can assert on.
    // roomSize is the fake's own test helper — the real WS adapter has no such method.
    const chat = h.container.chatService as FakeChatService
    expect(typeof chat.persist).toBe("function")
    expect(chat.roomSize("no-such-room")).toBe(0)
  })

  it("uses a caller-supplied container rather than building its own", async () => {
    const container = buildContainer(loadEnv({ NODE_ENV: "test" }))
    const h = await harness({ server: { container } })
    expect(h.container).toBe(container)
  })

  it("keeps env overrides isolated to the harness (no process.env leakage)", async () => {
    // WEB_ORIGINS is loaded from the harness's own minimal source; a DATABASE_URL in the developer's
    // shell must never reach an offline app, which is why loadEnv gets an explicit source here.
    const h = await harness({ webOrigins: ["https://app.civfix.org"], env: { PORT: "8123" } })
    expect(h.env.WEB_ORIGINS).toEqual(["https://app.civfix.org"])
    expect(h.env.PORT).toBe(8123)
    expect(h.env.DATABASE_URL).toBe("")
  })

  /**
   * The isolation claim has to hold on the DEFAULT path, not only when an override forces an explicit
   * source. It previously did not: with no options the harness passed loadEnv(undefined), so the ambient
   * environment — a developer's real DATABASE_URL among it — became the offline app's config.
   */
  it("ignores the ambient environment even with NO options passed", async () => {
    // Real infrastructure in the developer's shell, and a flag that would swap a fake for a live adapter.
    vi.stubEnv("DATABASE_URL", "postgres://real:secret@db.civfix.org:5432/civfix?sslmode=require")
    vi.stubEnv("REDIS_URL", "rediss://real-redis.civfix.org:6379")
    vi.stubEnv("USE_FAKE_STORAGE", "0")
    try {
      const h = await harness()
      expect(h.env.DATABASE_URL).toBe("")
      expect(h.env.REDIS_URL).toBe("")
      expect(h.env.NODE_ENV).toBe("test")
      // The harness's own source wins: the offline app keeps the fake storage seam.
      expect(h.env.USE_FAKE_STORAGE).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("still lets the caller override anything in that source", async () => {
    // NODE_ENV is the harness default most likely to need overriding (a NODE_ENV-gated branch); the
    // explicit USE_FAKE_* survive it, so the app stays offline instead of reaching for real adapters.
    const h = await harness({ env: { NODE_ENV: "development" } })
    expect(h.env.NODE_ENV).toBe("development")
    expect(h.env.USE_FAKE_STORAGE).toBe(true)
    expect(h.env.USE_FAKE_CHAT).toBe(true)
  })
})
