import { afterEach, describe, expect, it } from "vitest"
import { makeAuthHarness, type AuthHarness } from "../helpers/auth.js"
import { InMemoryNotificationRepository } from "../helpers/notifications.js"

const EMAIL = "leaving@example.com"
const BAN_MARKER_PREFIX = "banned:"

let harness: AuthHarness | undefined
afterEach(async () => {
  await harness?.app.close()
  harness = undefined
})

async function requestDeletionCode(h: AuthHarness): Promise<string> {
  await h.app.inject({
    method: "POST",
    url: "/v1/auth/otp/request",
    payload: { email: EMAIL },
  })
  return h.mailer.lastOtpFor(EMAIL)!
}

function deleteMe(h: AuthHarness, token: string, emailOtp: string) {
  return h.app.inject({
    method: "DELETE",
    url: "/v1/me",
    headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
    payload: { emailOtp },
  })
}

async function sessionUserId(h: AuthHarness, token: string): Promise<string | null> {
  const res = await h.app.inject({
    method: "GET",
    url: "/v1/auth/session",
    headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
  })
  return (res.json() as { user: { id: string } | null }).user?.id ?? null
}

describe("DELETE /v1/me after the erasure commits", () => {
  it("reports the deletion as done when the session ban marker cannot be written", async () => {
    harness = await makeAuthHarness()
    const { token, userId } = await harness.signIn(EMAIL)
    await harness.app.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { email: EMAIL },
    })
    const code = harness.mailer.lastOtpFor(EMAIL)!
    let banAttempts = 0
    harness.services.sessions.banUser = () => {
      banAttempts += 1
      return Promise.reject(new Error("redis unavailable"))
    }

    const res = await harness.app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
      payload: { emailOtp: code },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(banAttempts).toBe(1)
    expect((await harness.stores.users.findById(userId))?.deletedAt ?? null).not.toBeNull()
  })

  it("stops the deleted account's bearer from resolving", async () => {
    harness = await makeAuthHarness()
    const { token, userId } = await harness.signIn(EMAIL)
    expect(await sessionUserId(harness, token)).toBe(userId)

    const res = await deleteMe(harness, token, await requestDeletionCode(harness))

    expect(res.statusCode).toBe(200)
    expect(await harness.services.sessions.resolveSession(token)).toBeNull()
    expect(await sessionUserId(harness, token)).toBeNull()
    expect(harness.stores.sessions.count()).toBe(0)
  })

  it("keeps a cached bearer dead when the post-commit ban step fails", async () => {
    harness = await makeAuthHarness()
    const { token } = await harness.signIn(EMAIL)
    harness.services.sessions.banUser = () => Promise.reject(new Error("redis unavailable"))

    const res = await deleteMe(harness, token, await requestDeletionCode(harness))

    expect(res.statusCode).toBe(200)
    expect(await sessionUserId(harness, token)).toBeNull()
    expect(await harness.services.sessions.resolveSession(token)).toBeNull()
    expect(harness.stores.sessions.count()).toBe(0)
  })

  it("purges the user's push tokens and notifications with the erasure", async () => {
    const notificationRepo = new InMemoryNotificationRepository()
    harness = await makeAuthHarness({
      server: { notificationOverrides: { repo: notificationRepo } },
    })
    const { token, userId } = await harness.signIn(EMAIL)
    await notificationRepo.upsertPushToken({
      userId,
      platform: "ios",
      token: "device-token-leaving",
      deviceId: null,
    })
    await notificationRepo.upsertPushToken({
      userId: "someone-else",
      platform: "ios",
      token: "device-token-staying",
      deviceId: null,
    })
    await notificationRepo.insertNotification({
      userId,
      type: "report_update",
      title: "t",
      body: "b",
      link: null,
    })

    const res = await deleteMe(harness, token, await requestDeletionCode(harness))

    expect(res.statusCode).toBe(200)
    expect(notificationRepo.pushTokens.filter((t) => t.userId === userId)).toEqual([])
    expect(notificationRepo.notifications.filter((n) => n.userId === userId)).toEqual([])
    expect(notificationRepo.pushTokens.map((t) => t.token)).toEqual(["device-token-staying"])
  })
})

describe("DELETE /v1/me revocation is fail-closed", () => {
  it("answers 503 and deletes nothing when the ban marker cannot be set first", async () => {
    harness = await makeAuthHarness()
    const { token, userId } = await harness.signIn(EMAIL)
    const code = await requestDeletionCode(harness)
    const cache = harness.cache
    const realSet = cache.set.bind(cache)
    cache.set = (key, value, ttlSeconds) =>
      key.startsWith(BAN_MARKER_PREFIX)
        ? Promise.reject(new Error("redis unavailable"))
        : realSet(key, value, ttlSeconds)

    const res = await deleteMe(harness, token, code)

    expect(res.statusCode).toBe(503)
    expect(res.json().message).toBe(
      "We couldn't delete your account right now. Nothing was changed. Please try again in a few minutes.",
    )
    const after = await harness.stores.users.findById(userId)
    expect(after?.deletedAt ?? null).toBeNull()
    expect(after?.email).toBe(EMAIL)
    expect(await sessionUserId(harness, token)).toBe(userId)
  })

  it("holds the ban marker while the erasure transaction runs", async () => {
    harness = await makeAuthHarness()
    const { token, userId } = await harness.signIn(EMAIL)
    const users = harness.stores.users
    const realErase = users.softDeleteAndAnonymize.bind(users)
    let activeDuringErasure: boolean | undefined
    users.softDeleteAndAnonymize = async (id) => {
      activeDuringErasure = await harness!.services.sessions.isUserActive(id)
      return realErase(id)
    }

    const res = await deleteMe(harness, token, await requestDeletionCode(harness))

    expect(res.statusCode).toBe(200)
    expect(activeDuringErasure).toBe(false)
    expect(await harness.services.sessions.isUserActive(userId)).toBe(false)
  })

  it("clears the ban marker when the erasure transaction fails", async () => {
    harness = await makeAuthHarness()
    const { token, userId } = await harness.signIn(EMAIL)
    const code = await requestDeletionCode(harness)
    let activeDuringErasure: boolean | undefined
    harness.stores.users.softDeleteAndAnonymize = async (id) => {
      activeDuringErasure = await harness!.services.sessions.isUserActive(id)
      throw new Error("serialization failure")
    }

    const res = await deleteMe(harness, token, code)

    expect(res.statusCode).toBe(500)
    expect(activeDuringErasure).toBe(false)
    expect(await harness.services.sessions.isUserActive(userId)).toBe(true)
    expect(await sessionUserId(harness, token)).toBe(userId)
  })
})
