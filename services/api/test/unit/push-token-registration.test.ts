
import { describe, it, expect } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import { makeNotificationService } from "../../src/services/notification-service.js"
import { classifyPushToken } from "../../src/adapters/push-sender.js"
import { InMemoryNotificationRepository } from "../helpers/notifications.js"

const U = "11111111-1111-1111-1111-111111111111"

const P256DH = Buffer.alloc(65, 4).toString("base64url")
const AUTH = Buffer.alloc(16, 9).toString("base64url")

function subscription(endpoint: string, keys: { p256dh?: string; auth?: string } = {}): string {
  return JSON.stringify({
    endpoint,
    expirationTime: null,
    keys: { p256dh: keys.p256dh ?? P256DH, auth: keys.auth ?? AUTH },
  })
}

function harness(safeEndpoints: (endpoint: string) => boolean = () => true) {
  const repo = new InMemoryNotificationRepository()
  const push = new FakePushSender()
  const service = makeNotificationService({
    repo,
    pushSender: push,
    isSafePushEndpoint: (endpoint) => Promise.resolve(safeEndpoints(endpoint)),
  })
  return { repo, push, service }
}

describe("classifyPushToken", () => {
  it("accepts an Expo token under ANY platform (the mobile client registers one as ios/android)", () => {
    const token = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"
    expect(classifyPushToken("ios", token)).toEqual({ ok: true, kind: "expo" })
    expect(classifyPushToken("android", token)).toEqual({ ok: true, kind: "expo" })
    expect(classifyPushToken("web", token)).toEqual({ ok: true, kind: "expo" })
    expect(classifyPushToken("android", "ExpoPushToken[yyyyyyyyyyyyyyyyyyyyyy]")).toEqual({
      ok: true,
      kind: "expo",
    })
  })

  it("accepts a real browser PushSubscription JSON for platform web", () => {
    const shape = classifyPushToken("web", subscription("https://fcm.googleapis.com/fcm/send/abc123"))
    expect(shape).toEqual({
      ok: true,
      kind: "web",
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    })
  })

  it("rejects a web token that is not subscription JSON, is not https, or has malformed keys", () => {
    expect(classifyPushToken("web", "just-a-string").ok).toBe(false)
    expect(classifyPushToken("web", JSON.stringify({ endpoint: "https://x/y" })).ok).toBe(false)
    expect(classifyPushToken("web", subscription("http://push.example/x")).ok).toBe(false)
    expect(classifyPushToken("web", subscription("not a url")).ok).toBe(false)
    expect(classifyPushToken("web", subscription("https://push.example/x", { p256dh: "short" })).ok).toBe(
      false,
    )
    expect(
      classifyPushToken("web", subscription("https://push.example/x", { auth: "!!!not-base64url!!!" })).ok,
    ).toBe(false)
    expect(
      classifyPushToken("web", subscription("https://push.example/x", { auth: Buffer.alloc(32).toString("base64url") }))
        .ok,
    ).toBe(false)
  })

  it("gates raw device tokens on their platform's wire shape", () => {
    expect(classifyPushToken("ios", "d1".repeat(32))).toEqual({ ok: true, kind: "apns" })
    expect(classifyPushToken("ios", "not-hex").ok).toBe(false)
    expect(classifyPushToken("ios", "ab").ok).toBe(false)
    expect(classifyPushToken("android", `${"a".repeat(60)}:${"b".repeat(80)}`)).toEqual({
      ok: true,
      kind: "fcm",
    })
    expect(classifyPushToken("android", "short").ok).toBe(false)
    expect(classifyPushToken("android", `${"a".repeat(80)} with spaces`).ok).toBe(false)
  })
})

describe("registerPushToken validation (H15)", () => {
  it("stores a web subscription whose endpoint passes the send-time SSRF check", async () => {
    const { repo, service } = harness()
    await service.registerPushToken(U, {
      platform: "web",
      token: subscription("https://updates.push.services.mozilla.com/wpush/v2/abc"),
    })
    expect(repo.pushTokens).toHaveLength(1)
  })

  it("REFUSES an endpoint the sender would refuse (internal host) — never stored, never dialed", async () => {
    const { repo, service } = harness((endpoint) => !endpoint.includes("internal"))
    await expect(
      service.registerPushToken(U, {
        platform: "web",
        token: subscription("https://metadata.internal/push"),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(repo.pushTokens).toHaveLength(0)
  })

  it("REFUSES a non-https endpoint and malformed subscription keys before any DNS lookup", async () => {
    const { repo, service } = harness(() => {
      throw new Error("endpoint check must not run for a structurally invalid token")
    })
    await expect(
      service.registerPushToken(U, { platform: "web", token: subscription("http://push.example/x") }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    await expect(
      service.registerPushToken(U, {
        platform: "web",
        token: subscription("https://push.example/x", { p256dh: "nope" }),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(repo.pushTokens).toHaveLength(0)
  })

  it("keeps accepting exactly what the shipped mobile client sends", async () => {
    const { repo, service } = harness()
    await service.registerPushToken(U, {
      platform: "ios",
      token: "ExponentPushToken[abcdefghijklmnopqrst]",
      deviceId: "22222222-2222-4222-8222-222222222222",
    })
    expect(repo.pushTokens[0]).toMatchObject({ platform: "ios", revokedAt: null })
  })

  it("unregister is NOT gated: a legacy or malformed token must still be revocable", async () => {
    const { service } = harness()
    await expect(
      service.unregisterPushToken(U, { platform: "ios", token: "legacy-garbage" }),
    ).resolves.toEqual({ ok: true })
  })
})
