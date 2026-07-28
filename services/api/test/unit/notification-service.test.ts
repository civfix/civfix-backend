import { describe, it, expect } from "vitest"
import { FakePushSender, FakeUserChannel } from "@civfix/shared/fakes"
import {
  makeNotificationService,
  isWithinQuietHours,
  parseTimeOfDayMinutes,
  typeAllowedByPrefs,
  toPrefsDTO,
  DEFAULT_PREFS,
  type NotificationService,
  type NotificationPrefsRecord,
} from "../../src/services/notification-service.js"
import { InMemoryNotificationRepository } from "../helpers/notifications.js"
import { normalizeDeviceId } from "../../src/routes/notifications.routes.js"


const U = "11111111-1111-1111-1111-111111111111"
const V = "22222222-2222-2222-2222-222222222222"

function makeHarness(nowFn?: () => Date): {
  repo: InMemoryNotificationRepository
  push: FakePushSender
  service: NotificationService
} {
  const repo = new InMemoryNotificationRepository()
  const push = new FakePushSender()
  const service = makeNotificationService({
    repo,
    pushSender: push,
    ...(nowFn !== undefined ? { now: nowFn } : {}),
  })
  return { repo, push, service }
}


describe("parseTimeOfDayMinutes", () => {
  it("parses HH:MM and HH:MM:SS", () => {
    expect(parseTimeOfDayMinutes("00:00")).toBe(0)
    expect(parseTimeOfDayMinutes("07:30")).toBe(7 * 60 + 30)
    expect(parseTimeOfDayMinutes("22:00:00")).toBe(22 * 60)
    expect(parseTimeOfDayMinutes("23:59")).toBe(23 * 60 + 59)
  })

  it("returns null for malformed input", () => {
    expect(parseTimeOfDayMinutes("nope")).toBeNull()
    expect(parseTimeOfDayMinutes("24:00")).toBeNull()
    expect(parseTimeOfDayMinutes("12:60")).toBeNull()
    expect(parseTimeOfDayMinutes("")).toBeNull()
  })
})


function at(hh: number, mm = 0): Date {
  return new Date(Date.UTC(2025, 0, 1, hh, mm, 0, 0))
}

describe("isWithinQuietHours", () => {
  it("same-day window [09:00, 17:00): quiet inside, not at/after the end, not before the start", () => {
    expect(isWithinQuietHours(at(8, 59), "09:00", "17:00")).toBe(false)
    expect(isWithinQuietHours(at(9, 0), "09:00", "17:00")).toBe(true)
    expect(isWithinQuietHours(at(12, 0), "09:00", "17:00")).toBe(true)
    expect(isWithinQuietHours(at(16, 59), "09:00", "17:00")).toBe(true)
    expect(isWithinQuietHours(at(17, 0), "09:00", "17:00")).toBe(false)
  })

  it("wrap-around window [22:00, 07:00): quiet late night and early morning, awake midday", () => {
    expect(isWithinQuietHours(at(22, 0), "22:00", "07:00")).toBe(true)
    expect(isWithinQuietHours(at(23, 30), "22:00", "07:00")).toBe(true)
    expect(isWithinQuietHours(at(0, 0), "22:00", "07:00")).toBe(true)
    expect(isWithinQuietHours(at(6, 59), "22:00", "07:00")).toBe(true)
    expect(isWithinQuietHours(at(7, 0), "22:00", "07:00")).toBe(false)
    expect(isWithinQuietHours(at(12, 0), "22:00", "07:00")).toBe(false)
    expect(isWithinQuietHours(at(21, 59), "22:00", "07:00")).toBe(false)
  })

  it("equal bounds is treated as an EMPTY window (never quiet), not always-quiet", () => {
    expect(isWithinQuietHours(at(8, 0), "08:00", "08:00")).toBe(false)
    expect(isWithinQuietHours(at(0, 0), "00:00", "00:00")).toBe(false)
  })

  it("null bounds or malformed values fail open (not quiet)", () => {
    expect(isWithinQuietHours(at(3, 0), null, null)).toBe(false)
    expect(isWithinQuietHours(at(3, 0), "22:00", null)).toBe(false)
    expect(isWithinQuietHours(at(3, 0), "oops", "07:00")).toBe(false)
  })
})


describe("typeAllowedByPrefs", () => {
  const base: NotificationPrefsRecord = { ...DEFAULT_PREFS }

  it("requires the master push switch", () => {
    const off = { ...base, push: false }
    expect(typeAllowedByPrefs("new_follower", off)).toBe(false)
    expect(typeAllowedByPrefs("system", off)).toBe(false)
  })

  it("maps each type to its per-type toggle", () => {
    expect(typeAllowedByPrefs("new_follower", { ...base, follows: false })).toBe(false)
    expect(typeAllowedByPrefs("new_follower", { ...base, follows: true })).toBe(true)
    expect(typeAllowedByPrefs("report_update", { ...base, reportUpdates: false })).toBe(false)
    expect(typeAllowedByPrefs("claim_available", { ...base, reportUpdates: false })).toBe(false)
    expect(typeAllowedByPrefs("cleanup_chat", { ...base, cleanupChat: false })).toBe(false)
    expect(typeAllowedByPrefs("cleanup_reminder", { ...base, cleanupChat: false })).toBe(false)
    // WS4: role bells (promoted/demoted/removed) ride the cleanups pref bucket.
    expect(typeAllowedByPrefs("cleanup_role", { ...base, cleanupChat: false })).toBe(false)
    expect(typeAllowedByPrefs("cleanup_role", { ...base, cleanupChat: true })).toBe(true)
    expect(typeAllowedByPrefs("cleanup_cancelled", { ...base, cleanupChat: false })).toBe(false)
    expect(typeAllowedByPrefs("cleanup_cancelled", { ...base, cleanupChat: true })).toBe(true)
    expect(typeAllowedByPrefs("system", base)).toBe(true)
  })
})

describe("toPrefsDTO", () => {
  it("omits quietHours when either bound is null; includes it when both are set", () => {
    expect(toPrefsDTO(DEFAULT_PREFS).quietHours).toBeUndefined()
    const withQuiet = toPrefsDTO({ ...DEFAULT_PREFS, quietStart: "22:00", quietEnd: "07:00" })
    expect(withQuiet.quietHours).toEqual({ start: "22:00", end: "07:00" })
  })
})


describe("listNotifications + markRead", () => {
  it("lists newest-first and reflects read state", async () => {
    const { service } = makeHarness()
    await service.createNotification(U, { type: "system", title: "first" })
    await service.createNotification(U, { type: "system", title: "second" })
    await service.createNotification(U, { type: "system", title: "third" })

    const page = await service.listNotifications(U, { limit: 20 })
    expect(page.items.map((n) => n.title)).toEqual(["third", "second", "first"])
    expect(page.items.every((n) => n.read === false)).toBe(true)
  })

  it("markRead sets read=true for the given ids", async () => {
    const { service } = makeHarness()
    const a = await service.createNotification(U, { type: "system", title: "a" })
    await service.createNotification(U, { type: "system", title: "b" })

    const res = await service.markRead(U, [a.id])
    expect(res).toEqual({ ok: true })

    const page = await service.listNotifications(U, { limit: 20 })
    const readA = page.items.find((n) => n.id === a.id)!
    expect(readA.read).toBe(true)
    expect(page.items.filter((n) => n.read).length).toBe(1)
  })

  it("markRead only affects the caller's OWN notifications", async () => {
    const { service } = makeHarness()
    const mine = await service.createNotification(U, { type: "system", title: "mine" })
    const theirs = await service.createNotification(V, { type: "system", title: "theirs" })

    await service.markRead(U, [theirs.id, mine.id])

    const vPage = await service.listNotifications(V, { limit: 20 })
    expect(vPage.items.find((n) => n.id === theirs.id)!.read).toBe(false)
    const uPage = await service.listNotifications(U, { limit: 20 })
    expect(uPage.items.find((n) => n.id === mine.id)!.read).toBe(true)
  })

  it("markRead with an empty id list is a no-op that returns ok", async () => {
    const { service } = makeHarness()
    expect(await service.markRead(U, [])).toEqual({ ok: true })
  })

  it("paginates with a keyset cursor", async () => {
    const { service } = makeHarness()
    for (const t of ["n1", "n2", "n3"]) {
      await service.createNotification(U, { type: "system", title: t })
    }
    const page1 = await service.listNotifications(U, { limit: 2 })
    expect(page1.items.map((n) => n.title)).toEqual(["n3", "n2"])
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await service.listNotifications(U, { limit: 2, cursor: page1.nextCursor! })
    expect(page2.items.map((n) => n.title)).toEqual(["n1"])
    expect(page2.nextCursor).toBeNull()
  })
})

describe("feed excludes conversation-message notifications", () => {
  it("hides dm + cleanup_chat + report_chat from the feed read while still recording the row and pushing", async () => {
    const { repo, push, service } = makeHarness()
    await service.createNotification(U, { type: "report_update", title: "status changed", link: "/pin/x" })
    await service.createNotification(U, { type: "dm", title: "Alice", body: "hi", link: "/messages/dm/t1" })
    await service.createNotification(U, {
      type: "cleanup_chat",
      title: "Bob mentioned you",
      link: "/cleanups/c1",
    })
    await service.createNotification(U, {
      type: "report_chat",
      title: "Alice",
      body: "hi",
      link: "/messages/report/r1",
    })
    await service.createNotification(U, { type: "system", title: "welcome" })

    const page = await service.listNotifications(U, { limit: 20 })
    expect(page.items.map((n) => n.type).sort()).toEqual(["report_update", "system"])

    expect(
      repo.notifications
        .filter((n) => n.userId === U)
        .map((n) => n.type)
        .sort(),
    ).toEqual(["cleanup_chat", "dm", "report_chat", "report_update", "system"])

    expect(push.sent.filter((p) => p.userId === U)).toHaveLength(5)
  })
})

describe("getPrefs + updatePrefs", () => {
  it("creates all-true defaults (no quiet hours) on first read", async () => {
    const { repo, service } = makeHarness()
    const prefs = await service.getPrefs(U)
    expect(prefs).toEqual({
      push: true,
      cleanupChat: true,
      reportUpdates: true,
      follows: true,
      mentions: true,
      postInteractions: true,
    })
    expect(repo.prefs.has(U)).toBe(true)
  })

  it("applies a partial update, leaving the untouched toggles intact", async () => {
    const { service } = makeHarness()
    await service.getPrefs(U)
    const updated = await service.updatePrefs(U, { follows: false })
    expect(updated.follows).toBe(false)
    expect(updated.push).toBe(true)
    expect(updated.cleanupChat).toBe(true)
    expect(updated.reportUpdates).toBe(true)
    expect(updated.mentions).toBe(true)
  })

  it("carries the dedicated mentions toggle through a partial update", async () => {
    const { service } = makeHarness()
    await service.getPrefs(U)
    const muted = await service.updatePrefs(U, { mentions: false })
    expect(muted.mentions).toBe(false)
    expect(muted.push).toBe(true)
    expect(muted.cleanupChat).toBe(true)
    const after = await service.updatePrefs(U, { follows: false })
    expect(after.mentions).toBe(false)
  })

  it("sets and clears quiet hours", async () => {
    const { service } = makeHarness()
    const withQuiet = await service.updatePrefs(U, {
      quietHours: { start: "22:00", end: "07:00" },
    })
    expect(withQuiet.quietHours).toEqual({ start: "22:00", end: "07:00" })

    const cleared = await service.updatePrefs(U, { quietHours: null })
    expect(cleared.quietHours).toBeUndefined()
  })
})


describe("registerPushToken", () => {
  it("upserts a token and delegates to the PushSender", async () => {
    const { repo, push, service } = makeHarness()
    const res = await service.registerPushToken(U, {
      platform: "ios",
      token: "tok-1",
      deviceId: "dev-1",
    })
    expect(res).toEqual({ ok: true })
    expect(repo.pushTokens).toHaveLength(1)
    expect(repo.pushTokens[0]).toMatchObject({
      userId: U,
      platform: "ios",
      token: "tok-1",
      deviceId: "dev-1",
      revokedAt: null,
    })
    expect(push.tokens).toHaveLength(1)
    expect(push.tokens[0]).toMatchObject({ userId: U, token: "tok-1", platform: "ios" })
  })

  it("the SAME user re-registering re-activates a revoked token (owner update)", async () => {
    const { repo, service } = makeHarness()
    await service.registerPushToken(U, { platform: "android", token: "tok-x", deviceId: "d1" })
    repo.pushTokens[0]!.revokedAt = new Date()

    await service.registerPushToken(U, { platform: "android", token: "tok-x", deviceId: "d1" })
    expect(repo.pushTokens).toHaveLength(1)
    expect(repo.pushTokens[0]).toMatchObject({ userId: U, deviceId: "d1", revokedAt: null })
  })

  it("P1-3 / H11: a DIFFERENT user with a different/absent device_id CANNOT hijack the token, and gets a real ERROR", async () => {
    const { repo, push, service } = makeHarness()
    await service.registerPushToken(U, { platform: "android", token: "tok-x", deviceId: "d1" })
    expect(push.tokens).toHaveLength(1)

    // H11: this used to resolve {ok:true}, so the client believed registration succeeded while the
    // token stayed bound to whoever registered FIRST — the legitimate device owner silently lost push
    // forever with no signal anywhere. The conflict is now surfaced as an error the client can act on.
    await expect(
      service.registerPushToken(V, { platform: "android", token: "tok-x", deviceId: "d2" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })

    expect(repo.pushTokens).toHaveLength(1)
    expect(repo.pushTokens[0]).toMatchObject({ userId: U, deviceId: "d1", revokedAt: null })
    expect(push.tokens.some((t) => t.userId === V)).toBe(false)
    expect(push.tokens).toHaveLength(1)
  })

  it("P1-3: a different user presenting the SAME non-null device_id IS allowed (genuine handoff)", async () => {
    const { repo, service } = makeHarness()
    await service.registerPushToken(U, { platform: "android", token: "tok-x", deviceId: "shared-device" })
    await service.registerPushToken(V, { platform: "android", token: "tok-x", deviceId: "shared-device" })
    expect(repo.pushTokens).toHaveLength(1)
    expect(repo.pushTokens[0]).toMatchObject({ userId: V, deviceId: "shared-device", revokedAt: null })
  })

  it("H12: a self-declared device_id does NOT revoke another account's token (mass-revoke closed)", async () => {
    const { repo, service } = makeHarness()
    await service.registerPushToken(U, { platform: "ios", token: "tok-U", deviceId: "shared" })
    // V claims the same device_id with a DIFFERENT token. Previously this soft-revoked every active
    // token carrying that device_id across every account — one harvested device-id list was a
    // fleet-wide push blackout. The device_id branch is gone: the revoke is scoped to the presented
    // TOKEN, which the caller provably holds.
    await service.registerPushToken(V, { platform: "ios", token: "tok-V", deviceId: "shared" })

    const uRow = repo.pushTokens.find((t) => t.token === "tok-U")
    const vRow = repo.pushTokens.find((t) => t.token === "tok-V")
    expect(uRow).toMatchObject({ userId: U, revokedAt: null })
    expect(vRow).toMatchObject({ userId: V, revokedAt: null })
  })

  it("device-claim: does NOT revoke another user's token on a DIFFERENT device", async () => {
    const { repo, service } = makeHarness()
    await service.registerPushToken(U, { platform: "ios", token: "tok-U", deviceId: "device-A" })
    await service.registerPushToken(V, { platform: "ios", token: "tok-V", deviceId: "device-B" })
    expect(repo.pushTokens.find((t) => t.token === "tok-U")?.revokedAt).toBeNull()
  })

  it("device-claim: a registration WITHOUT a device_id revokes nobody (no device proof)", async () => {
    const { repo, service } = makeHarness()
    await service.registerPushToken(U, { platform: "ios", token: "tok-U", deviceId: "shared" })
    await service.registerPushToken(V, { platform: "ios", token: "tok-V" })
    expect(repo.pushTokens.find((t) => t.token === "tok-U")?.revokedAt).toBeNull()
  })
})


describe("createNotification (inline-send gating)", () => {
  it("records the row and sends a push when prefs allow + not in quiet hours", async () => {
    const { repo, push, service } = makeHarness(() => at(12, 0))
    const dto = await service.createNotification(U, {
      type: "new_follower",
      title: "New follower",
      body: "Alice started following you.",
      link: "/people/x",
    })
    expect(repo.notifications).toHaveLength(1)
    expect(dto.title).toBe("New follower")
    expect(dto.read).toBe(false)
    expect(push.sent).toHaveLength(1)
    expect(push.sent[0]!.userId).toBe(U)
    expect(push.sent[0]!.payload.title).toBe("New follower")
    expect(push.sent[0]!.payload.body).toBe("Alice started following you.")
    expect(push.sent[0]!.payload.link).toBe("/people/x")
    expect(push.sent[0]!.payload.data).toMatchObject({ type: "new_follower", notificationId: dto.id })
  })

  it("does NOT push when the master push switch is off (but still records the row)", async () => {
    const { repo, push, service } = makeHarness(() => at(12, 0))
    await service.updatePrefs(U, { push: false })
    await service.createNotification(U, { type: "new_follower", title: "x" })
    expect(repo.notifications).toHaveLength(1)
    expect(push.sent).toHaveLength(0)
  })

  it("does NOT push when the per-type toggle is off (but still records the row)", async () => {
    const { repo, push, service } = makeHarness(() => at(12, 0))
    await service.updatePrefs(U, { follows: false })
    await service.createNotification(U, { type: "new_follower", title: "x" })
    expect(repo.notifications).toHaveLength(1)
    expect(push.sent).toHaveLength(0)
    await service.createNotification(U, { type: "report_update", title: "y" })
    expect(push.sent).toHaveLength(1)
  })

  it("does NOT push within quiet hours (but still records the row)", async () => {
    const { repo, push, service } = makeHarness(() => at(23, 0))
    await service.updatePrefs(U, { quietHours: { start: "22:00", end: "07:00" } })
    await service.createNotification(U, { type: "system", title: "late" })
    expect(repo.notifications).toHaveLength(1)
    expect(push.sent).toHaveLength(0)
  })

  it("pushes again once outside quiet hours", async () => {
    let nowMs = at(23, 0).getTime()
    const { push, service } = makeHarness(() => new Date(nowMs))
    await service.updatePrefs(U, { quietHours: { start: "22:00", end: "07:00" } })
    await service.createNotification(U, { type: "system", title: "late" })
    expect(push.sent).toHaveLength(0)
    nowMs = at(12, 0).getTime()
    await service.createNotification(U, { type: "system", title: "noon" })
    expect(push.sent).toHaveLength(1)
  })

  it("a push failure never breaks the call; the row is still recorded", async () => {
    const repo = new InMemoryNotificationRepository()
    const failingPush = new FakePushSender()
    failingPush.send = () => Promise.reject(new Error("send boom"))
    const service = makeNotificationService({ repo, pushSender: failingPush, now: () => at(12, 0) })

    const dto = await service.createNotification(U, { type: "system", title: "ok" })
    expect(dto.title).toBe("ok")
    expect(repo.notifications).toHaveLength(1)
  })
})


describe("onNewFollower", () => {
  it("records a new_follower notification for the followee with a friendly body + link", async () => {
    const { repo, push, service } = makeHarness(() => at(12, 0))
    await service.onNewFollower({
      followeeId: U,
      follower: { id: V, displayName: "Alice", handle: "alice", bio: null, followers: 0, following: 0, verified: false, avatarR2Key: null, avatarUrl: null, socialLinks: null, showVolunteerHours: null },
    })
    expect(repo.notifications).toHaveLength(1)
    const n = repo.notifications[0]!
    expect(n.userId).toBe(U)
    expect(n.type).toBe("new_follower")
    expect(n.body).toContain("Alice")
    expect(n.link).toBe(`/people/${V}`)
    expect(push.sent).toHaveLength(1)
  })
})


describe("createNotification (per-user signal)", () => {
  function makeSignalHarness(): {
    repo: InMemoryNotificationRepository
    channel: FakeUserChannel
    service: NotificationService
  } {
    const repo = new InMemoryNotificationRepository()
    const channel = new FakeUserChannel()
    const service = makeNotificationService({
      repo,
      pushSender: new FakePushSender(),
      userChannel: channel,
      now: () => at(12, 0),
    })
    return { repo, channel, service }
  }

  it("publishes exactly ONE {topic:'notifications'} signal to the recipient", async () => {
    const { channel, service } = makeSignalHarness()
    await service.createNotification(U, { type: "report_update", title: "Your report was updated" })
    expect(channel.published).toHaveLength(1)
    expect(channel.published[0]!.userId).toBe(U)
    expect(channel.published[0]!.signal).toEqual({ topic: "notifications" })
  })

  it("signals the SINGLE notifications topic regardless of the notification type", async () => {
    const { channel, service } = makeSignalHarness()
    await service.createNotification(U, { type: "new_follower", title: "x" })
    await service.createNotification(U, { type: "cleanup_chat", title: "y" })
    await service.createNotification(U, { type: "system", title: "z" })
    expect(channel.published).toHaveLength(3)
    expect(channel.published.every((p) => p.userId === U && p.signal.topic === "notifications")).toBe(
      true,
    )
  })

  it("signals even when the PUSH is suppressed (prefs/quiet hours gate push, not the in-app badge)", async () => {
    const { channel, service } = makeSignalHarness()
    await service.updatePrefs(U, { push: false })
    await service.createNotification(U, { type: "new_follower", title: "x" })
    expect(channel.published).toHaveLength(1)
    expect(channel.published[0]!.signal).toEqual({ topic: "notifications" })
  })

  it("STILL returns the row when publishToUser throws (the row is already persisted)", async () => {
    const repo = new InMemoryNotificationRepository()
    const channel = new FakeUserChannel()
    channel.publishToUser = () => Promise.reject(new Error("signal boom"))
    const service = makeNotificationService({
      repo,
      pushSender: new FakePushSender(),
      userChannel: channel,
      now: () => at(12, 0),
    })

    const dto = await service.createNotification(U, { type: "system", title: "ok" })
    expect(dto.title).toBe("ok")
    expect(repo.notifications).toHaveLength(1)
  })

  it("no channel wired -> records the row and publishes nothing", async () => {
    const { repo, service } = makeHarness(() => at(12, 0))
    await service.createNotification(U, { type: "system", title: "ok" })
    expect(repo.notifications).toHaveLength(1)
  })
})

/**
 * H12 — `deviceId` arrives from a JSON body as an unconstrained string in the shared contract and the
 * server used it to key a destructive cross-account write. It is now shape-gated at the route boundary
 * and, critically, DROPPED rather than rejected: 422-ing an older client would cost it push entirely,
 * which is the exact silent-failure mode H11 is about.
 */
describe("normalizeDeviceId (H12)", () => {
  it("accepts a UUID (the shape the mobile client stores in SecureStore), normalized", () => {
    expect(normalizeDeviceId("3F2504E0-4F89-41D3-9A0C-0305E82C3301")).toBe(
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    )
    expect(normalizeDeviceId("  3f2504e0-4f89-41d3-9a0c-0305e82c3301  ")).toBe(
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    )
  })

  it("DROPS a malformed value instead of rejecting the registration", () => {
    for (const bad of ["*", "%", "a".repeat(5000), "not-a-uuid", "'; DROP", ""]) {
      expect(normalizeDeviceId(bad)).toBeUndefined()
    }
  })

  it("passes through an absent value unchanged", () => {
    expect(normalizeDeviceId(undefined)).toBeUndefined()
  })
})
