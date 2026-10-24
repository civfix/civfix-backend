// GH#225 / D10: "Stop these emails" unchecks Email for one category. The GET a mail client opens only
// redirects to the web page; the POST (the page, or an RFC 8058 one-click sender) writes. Neither a
// broadcast token here nor a notification token on the broadcast route does anything.

import { afterEach, describe, expect, it, vi } from "vitest"
import { FakeMailer } from "@civfix/seams"
import {
  NOTIFICATION_CATEGORY_DEFAULTS,
  UNSUBSCRIBE_TOKEN_MAX,
  UNSUBSCRIBE_TOKEN_MIN,
} from "@civfix/contract"
import type { NotificationCategory } from "@civfix/contract"
import { makeAuthHarness, type AuthHarness } from "../helpers/auth.js"
import {
  InMemoryNotificationRepository,
  InMemoryNotificationSettingsRepository,
} from "../helpers/notifications.js"
import { InMemoryBroadcastRepository } from "../helpers/host/broadcast-repository.memory.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { makeBroadcastService } from "../../src/services/host/broadcast-service.js"
import type { CommsRuntime } from "../../src/services/host/comms-wiring.js"
import { webBaseUrlOf } from "../../src/lib/base-url.js"
import {
  mintNotificationEmailToken,
  notificationEmailExpiryFrom,
} from "../../src/services/notification-email-token.js"
import {
  mintUnsubscribeToken,
  unsubscribeExpiryFrom,
} from "../../src/services/host/broadcast-capability-token.js"

const U = "aaaaaaaa-0000-4000-8000-000000000001"
const ERASED = "bbbbbbbb-0000-4000-8000-000000000002"
const MISSING = "cccccccc-0000-4000-8000-000000000003"
const EVENT = "eeeeeeee-0000-4000-8000-00000000000e"
const URL = "/v1/notifications/email-unsubscribe"
const KEY = "notification-unsubscribe-route-test-key-0123456789"

let harness: AuthHarness | undefined

afterEach(async () => {
  await harness?.app.close()
  harness = undefined
})

async function build() {
  const repo = new InMemoryNotificationRepository()
  const settings = new InMemoryNotificationSettingsRepository()
  settings.liveUserIds.add(U)
  const writes: string[] = []
  const disableEmail = settings.disableEmail.bind(settings)
  settings.disableEmail = (userId, category) => {
    writes.push(`${userId}:${category}`)
    return disableEmail(userId, category)
  }
  const broadcastRepo = new InMemoryBroadcastRepository()
  const recordUnsubscribe = vi.spyOn(broadcastRepo, "recordUnsubscribe")
  harness = await makeAuthHarness({
    env: { UNSUBSCRIBE_SIGNING_KEY: KEY },
    server: {
      notificationOverrides: { repo, settingsRepo: settings },
      broadcastOverrides: {
        runtime: {
          broadcasts: makeBroadcastService({
            repo: broadcastRepo,
            counters: new InMemoryCounterStore(),
            config: { unsubscribeSigningKey: KEY } as never,
            mailer: new FakeMailer(),
            enqueuePlan: () => Promise.resolve(),
          }),
        } as unknown as CommsRuntime,
      },
    },
  })
  const env = harness.env
  const key = env.UNSUBSCRIBE_SIGNING_KEY
  expect(key).toBe(KEY)
  const token = (userId: string, category: NotificationCategory, expiresAtMs?: number) =>
    mintNotificationEmailToken(
      {
        userId,
        category,
        expiresAtMs: expiresAtMs ?? notificationEmailExpiryFrom(Date.now()),
      },
      key,
    )
  const broadcastToken = () =>
    mintUnsubscribeToken(
      {
        subjectKind: "user",
        subjectId: U,
        cleanupId: EVENT,
        expiresAtMs: unsubscribeExpiryFrom(Date.now()),
      },
      key,
    )
  const stored = (userId: string) =>
    [...settings.rows.values()]
      .filter((r) => r.userId === userId)
      .map(({ category, enabled, push, email }) => ({ category, enabled, push, email }))
  return {
    app: harness.app,
    web: webBaseUrlOf(env),
    settings,
    writes,
    recordUnsubscribe,
    token,
    broadcastToken,
    stored,
  }
}

describe("POST /v1/notifications/email-unsubscribe", () => {
  it("T34: a JSON token unchecks Email for that category only, signed out and without CSRF", async () => {
    const h = await build()
    await h.settings.upsertSettings(U, { followers: { enabled: true, push: false, email: true } })

    const res = await h.app.inject({
      method: "POST",
      url: URL,
      payload: { token: h.token(U, "events") },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, category: "events" })
    expect(h.stored(U).sort((a, b) => a.category.localeCompare(b.category))).toEqual([
      { category: "events", enabled: true, push: true, email: false },
      { category: "followers", enabled: true, push: false, email: true },
    ])
    expect(NOTIFICATION_CATEGORY_DEFAULTS.events).toEqual({
      enabled: true,
      push: true,
      email: true,
    })
  })

  it("T35: an RFC 8058 one-click form post reads the token from the query", async () => {
    const h = await build()
    await h.settings.upsertSettings(U, {
      hostAnnouncements: { enabled: true, push: false, email: true },
    })

    const res = await h.app.inject({
      method: "POST",
      url: `${URL}?t=${encodeURIComponent(h.token(U, "hostAnnouncements"))}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=One-Click",
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, category: "hostAnnouncements" })
    expect(h.stored(U)).toEqual([
      { category: "hostAnnouncements", enabled: true, push: false, email: false },
    ])
  })

  it("T36: posting the same token twice answers the same and stays unchecked", async () => {
    const h = await build()
    const payload = { token: h.token(U, "events") }

    const first = await h.app.inject({ method: "POST", url: URL, payload })
    const second = await h.app.inject({ method: "POST", url: URL, payload })

    for (const res of [first, second]) {
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true, category: "events" })
    }
    expect(h.stored(U)).toEqual([{ category: "events", enabled: true, push: true, email: false }])
  })

  it("T37: an absent, short, tampered, expired or broadcast token answers category null and writes nothing", async () => {
    const h = await build()
    const valid = h.token(U, "events")
    const [prefix, body, sig] = valid.split(".") as [string, string, string]
    const flipped = sig.startsWith("A") ? `B${sig.slice(1)}` : `A${sig.slice(1)}`
    const cases: Record<string, Record<string, unknown>> = {
      absent: {},
      short: { token: "n1.x".padEnd(UNSUBSCRIBE_TOKEN_MIN - 1, "x") },
      tampered: { token: `${prefix}.${body}.${flipped}` },
      expired: { token: h.token(U, "events", Date.now() - 1000) },
      broadcast: { token: h.broadcastToken() },
    }

    for (const [name, payload] of Object.entries(cases)) {
      const res = await h.app.inject({ method: "POST", url: URL, payload })
      expect(res.statusCode, name).toBe(200)
      expect(res.json(), name).toEqual({ ok: true, category: null })
    }
    expect(h.writes).toEqual([])
    expect(h.stored(U)).toEqual([])
  })

  it("T38: a token for an erased or unknown account does nothing", async () => {
    const h = await build()

    for (const userId of [ERASED, MISSING]) {
      const res = await h.app.inject({
        method: "POST",
        url: URL,
        payload: { token: h.token(userId, "events") },
      })
      expect(res.statusCode, userId).toBe(200)
      expect(res.json(), userId).toEqual({ ok: true, category: null })
      expect(h.stored(userId), userId).toEqual([])
    }
  })

  it("T39: a failed write answers 503 so a one-click sender retries", async () => {
    const h = await build()
    h.settings.disableEmail = () => Promise.reject(new Error("connection terminated"))

    const res = await h.app.inject({
      method: "POST",
      url: URL,
      payload: { token: h.token(U, "events") },
    })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({
      message: "We couldn't save your unsubscribe. Please try again.",
    })
  })
})

describe("POST /v1/broadcasts/unsubscribe", () => {
  it("T40: a notification token unsubscribes from nothing", async () => {
    const h = await build()

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/broadcasts/unsubscribe",
      payload: { token: h.token(U, "events") },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(h.recordUnsubscribe).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
    expect(h.stored(U)).toEqual([])
  })
})

describe("GET /v1/notifications/email-unsubscribe", () => {
  it("T41: redirects any well-formed token to the web page and changes nothing", async () => {
    const h = await build()
    const valid = h.token(U, "events")
    const [prefix, body] = valid.split(".") as [string, string, string]
    const forged = `${prefix}.${body}.${"x".repeat(43)}`

    for (const token of [forged, valid]) {
      const res = await h.app.inject({
        method: "GET",
        url: `${URL}?t=${encodeURIComponent(token)}`,
      })
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe(
        `${h.web}/unsubscribe/notifications/?t=${encodeURIComponent(token)}`,
      )
    }
    expect(h.writes).toEqual([])
    expect(h.stored(U)).toEqual([])
  })

  it("T42: a missing, short or overlong token redirects to the bare page", async () => {
    const h = await build()
    const queries = [
      "",
      `?t=${"x".repeat(UNSUBSCRIBE_TOKEN_MIN - 1)}`,
      `?t=${"x".repeat(UNSUBSCRIBE_TOKEN_MAX + 1)}`,
    ]

    for (const query of queries) {
      const res = await h.app.inject({ method: "GET", url: `${URL}${query}` })
      expect(res.statusCode, query.slice(0, 10)).toBe(302)
      expect(res.headers.location).toBe(`${h.web}/unsubscribe/notifications/`)
    }
  })
})

describe("rate limit", () => {
  it("T43: the 61st request in a minute from one host is refused, on each route", async () => {
    for (const method of ["GET", "POST"] as const) {
      const h = await build()
      const send = () =>
        h.app.inject({
          method,
          url: URL,
          ...(method === "POST" ? { payload: {} } : {}),
        })
      for (let i = 0; i < 60; i++) {
        expect((await send()).statusCode, `${method} ${i + 1}`).not.toBe(429)
      }
      expect((await send()).statusCode, method).toBe(429)
      await harness?.app.close()
      harness = undefined
    }
  })
})
