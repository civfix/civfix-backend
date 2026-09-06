import { describe, it, expect } from "vitest"
import { FakePushSender, FakeUserChannel } from "@civfix/shared/fakes"
import {
  makeNotificationService,
  isWithinQuietHours,
  parseTimeOfDayMinutes,
  typeAllowedByPrefs,
  toPrefsDTO,
  DEFAULT_PREFS,
  FEED_HIDDEN_NOTIFICATION_TYPES,
  NOTIFICATION_DEDUPE_WINDOW_MS,
  type NotificationService,
  type NotificationPrefsRecord,
} from "../../src/services/notification-service.js"
import { MAX_ACTIVE_PUSH_TOKENS_PER_USER } from "../../src/services/notification-repository.drizzle.js"
import { InMemoryNotificationRepository, flushNotificationDispatch } from "../helpers/notifications.js"
import { normalizeDeviceId } from "../../src/routes/notifications.routes.js"


const TOK_1 = "d1".repeat(32)
const TOK_SHARED = "d5".repeat(32)
const capToken = (i: number): string => `${"ef".repeat(30)}${String(i).padStart(4, "0")}`
const TOK_X = "d2".repeat(32)
const TOK_U = "d3".repeat(32)
const TOK_V = "d4".repeat(32)

const U = "11111111-1111-1111-1111-111111111111"
const V = "22222222-2222-2222-2222-222222222222"

function makeHarness(nowFn?: () => Date): {
  repo: InMemoryNotificationRepository
  push: FakePushSender
  service: NotificationService
} {
  const repo = new InMemoryNotificationRepository()
  if (nowFn !== undefined) repo.now = nowFn
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
  it("same-day window [09:00, 17:00) evaluated in the stored zone (UTC here)", () => {
    expect(isWithinQuietHours(at(8, 59), "09:00", "17:00", "UTC")).toBe(false)
    expect(isWithinQuietHours(at(9, 0), "09:00", "17:00", "UTC")).toBe(true)
    expect(isWithinQuietHours(at(12, 0), "09:00", "17:00", "UTC")).toBe(true)
    expect(isWithinQuietHours(at(16, 59), "09:00", "17:00", "UTC")).toBe(true)
    expect(isWithinQuietHours(at(17, 0), "09:00", "17:00", "UTC")).toBe(false)
  })

  it("wrap-around window [22:00, 07:00): quiet late night and early morning, awake midday", () => {
    expect(isWithinQuietHours(at(22, 0), "22:00", "07:00", "UTC")).toBe(true)
    expect(isWithinQuietHours(at(23, 30), "22:00", "07:00", "UTC")).toBe(true)
    expect(isWithinQuietHours(at(0, 0), "22:00", "07:00", "UTC")).toBe(true)
    expect(isWithinQuietHours(at(6, 59), "22:00", "07:00", "UTC")).toBe(true)
    expect(isWithinQuietHours(at(7, 0), "22:00", "07:00", "UTC")).toBe(false)
    expect(isWithinQuietHours(at(12, 0), "22:00", "07:00", "UTC")).toBe(false)
    expect(isWithinQuietHours(at(21, 59), "22:00", "07:00", "UTC")).toBe(false)
  })

  it("equal bounds is treated as an EMPTY window (never quiet), not always-quiet", () => {
    expect(isWithinQuietHours(at(8, 0), "08:00", "08:00", "UTC")).toBe(false)
    expect(isWithinQuietHours(at(0, 0), "00:00", "00:00", "UTC")).toBe(false)
  })

  it("null bounds or malformed values fail open (not quiet)", () => {
    expect(isWithinQuietHours(at(3, 0), null, null, "UTC")).toBe(false)
    expect(isWithinQuietHours(at(3, 0), "22:00", null, "UTC")).toBe(false)
    expect(isWithinQuietHours(at(3, 0), "oops", "07:00", "UTC")).toBe(false)
  })

  it("F086: a NULL zone disables suppression (fail open) rather than guessing UTC", () => {
    expect(isWithinQuietHours(at(23, 0), "22:00", "07:00", null)).toBe(false)
    expect(isWithinQuietHours(at(12, 0), "09:00", "17:00", null)).toBe(false)
  })

  it("F086: the window is evaluated in the stored IANA zone, honoring the UTC offset", () => {
    expect(isWithinQuietHours(at(6, 0), "22:00", "07:00", "America/Los_Angeles")).toBe(true)
    expect(isWithinQuietHours(at(20, 0), "22:00", "07:00", "America/Los_Angeles")).toBe(false)
    expect(isWithinQuietHours(at(23, 0), "22:00", "07:00", "Not/AZone")).toBe(false)
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

    await flushNotificationDispatch()
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
      hostBroadcasts: true,
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

  it("F086: round-trips the quiet-hours IANA zone and clears it with the window", async () => {
    const { service } = makeHarness()
    const withZone = await service.updatePrefs(U, {
      quietHours: { start: "22:00", end: "07:00", tz: "America/Los_Angeles" },
    })
    expect(withZone.quietHours).toEqual({
      start: "22:00",
      end: "07:00",
      tz: "America/Los_Angeles",
    })
    const cleared = await service.updatePrefs(U, { quietHours: null })
    expect(cleared.quietHours).toBeUndefined()
  })
})


describe("registerPushToken", () => {
  it("upserts a token and delegates to the PushSender", async () => {
    const { repo, push, service } = makeHarness()
    const res = await service.registerPushToken(U, {
      platform: "ios",
      token: TOK_1,
      deviceId: "dev-1",
    })
    expect(res).toEqual({ ok: true })
    expect(repo.pushTokens).toHaveLength(1)
    expect(repo.pushTokens[0]).toMatchObject({
      userId: U,
      platform: "ios",
      token: TOK_1,
      deviceId: "dev-1",
      revokedAt: null,
    })
    expect(push.tokens).toHaveLength(1)
    expect(push.tokens[0]).toMatchObject({ userId: U, token: TOK_1, platform: "ios" })
  })

  it("the SAME user re-registering re-activates a revoked token (owner update)", async () => {
    const { repo, service } = makeHarness()
    await service.registerPushToken(U, { platform: "android", token: TOK_X, deviceId: "d1" })
    repo.pushTokens[0]!.revokedAt = new Date()

    await service.registerPushToken(U, { platform: "android", token: TOK_X, deviceId: "d1" })
    expect(repo.pushTokens).toHaveLength(1)
    expect(repo.pushTokens[0]).toMatchObject({ userId: U, deviceId: "d1", revokedAt: null })
  })

  it("P1-3 / H11: a DIFFERENT user with a different/absent device_id CANNOT hijack the token, and gets a real ERROR", async () => {
    const { repo, push, service } = makeHarness()
    await service.registerPushToken(U, { platform: "android", token: TOK_X, deviceId: "d1" })
    expect(push.tokens).toHaveLength(1)

    await expect(
      service.registerPushToken(V, { platform: "android", token: TOK_X, deviceId: "d2" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })

    expect(repo.pushTokens).toHaveLength(1)
    expect(repo.pushTokens[0]).toMatchObject({ userId: U, deviceId: "d1", revokedAt: null })
    expect(push.tokens.some((t) => t.userId === V)).toBe(false)
    expect(push.tokens).toHaveLength(1)
  })

  it("F153: a matching device_id can NO LONGER take over another account's (platform,token) row", async () => {
    const { repo, service } = makeHarness()
    await service.registerPushToken(U, { platform: "android", token: TOK_X, deviceId: "shared-device" })
    await expect(
      service.registerPushToken(V, { platform: "android", token: TOK_X, deviceId: "shared-device" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(repo.pushTokens).toHaveLength(1)
    expect(repo.pushTokens[0]).toMatchObject({ userId: U, deviceId: "shared-device", revokedAt: null })
  })

  it("H12: a self-declared device_id does NOT revoke another account's token (mass-revoke closed)", async () => {
    const { repo, service } = makeHarness()
    await service.registerPushToken(U, { platform: "ios", token: TOK_U, deviceId: "shared" })
    await service.registerPushToken(V, { platform: "ios", token: TOK_V, deviceId: "shared" })

    const uRow = repo.pushTokens.find((t) => t.token === TOK_U)
    const vRow = repo.pushTokens.find((t) => t.token === TOK_V)
    expect(uRow).toMatchObject({ userId: U, revokedAt: null })
    expect(vRow).toMatchObject({ userId: V, revokedAt: null })
  })

  it("device-claim: does NOT revoke another user's token on a DIFFERENT device", async () => {
    const { repo, service } = makeHarness()
    await service.registerPushToken(U, { platform: "ios", token: TOK_U, deviceId: "device-A" })
    await service.registerPushToken(V, { platform: "ios", token: TOK_V, deviceId: "device-B" })
    expect(repo.pushTokens.find((t) => t.token === TOK_U)?.revokedAt).toBeNull()
  })

  it("device-claim: a registration WITHOUT a device_id revokes nobody (no device proof)", async () => {
    const { repo, service } = makeHarness()
    await service.registerPushToken(U, { platform: "ios", token: TOK_U, deviceId: "shared" })
    await service.registerPushToken(V, { platform: "ios", token: TOK_V })
    expect(repo.pushTokens.find((t) => t.token === TOK_U)?.revokedAt).toBeNull()
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
    await flushNotificationDispatch()
    expect(push.sent).toHaveLength(1)
    await flushNotificationDispatch()
    expect(push.sent[0]!.userId).toBe(U)
    await flushNotificationDispatch()
    expect(push.sent[0]!.payload.title).toBe("New follower")
    await flushNotificationDispatch()
    expect(push.sent[0]!.payload.body).toBe("Alice started following you.")
    await flushNotificationDispatch()
    expect(push.sent[0]!.payload.link).toBe("/people/x")
    await flushNotificationDispatch()
    expect(push.sent[0]!.payload.data).toMatchObject({ type: "new_follower", notificationId: dto.id })
  })

  it("does NOT push when the master push switch is off (but still records the row)", async () => {
    const { repo, push, service } = makeHarness(() => at(12, 0))
    await service.updatePrefs(U, { push: false })
    await service.createNotification(U, { type: "new_follower", title: "x" })
    expect(repo.notifications).toHaveLength(1)
    await flushNotificationDispatch()
    expect(push.sent).toHaveLength(0)
  })

  it("does NOT push when the per-type toggle is off (but still records the row)", async () => {
    const { repo, push, service } = makeHarness(() => at(12, 0))
    await service.updatePrefs(U, { follows: false })
    await service.createNotification(U, { type: "new_follower", title: "x" })
    expect(repo.notifications).toHaveLength(1)
    await flushNotificationDispatch()
    expect(push.sent).toHaveLength(0)
    await service.createNotification(U, { type: "report_update", title: "y" })
    await flushNotificationDispatch()
    expect(push.sent).toHaveLength(1)
  })

  it("does NOT push within quiet hours (but still records the row)", async () => {
    const { repo, push, service } = makeHarness(() => at(23, 0))
    await service.updatePrefs(U, { quietHours: { start: "22:00", end: "07:00", tz: "UTC" } })
    await service.createNotification(U, { type: "system", title: "late" })
    expect(repo.notifications).toHaveLength(1)
    await flushNotificationDispatch()
    expect(push.sent).toHaveLength(0)
  })

  it("F086: quiet hours with NO zone fail open (suppression disabled, push still sent)", async () => {
    const { repo, push, service } = makeHarness(() => at(23, 0))
    await service.updatePrefs(U, { quietHours: { start: "22:00", end: "07:00" } })
    await service.createNotification(U, { type: "system", title: "late" })
    expect(repo.notifications).toHaveLength(1)
    await flushNotificationDispatch()
    expect(push.sent).toHaveLength(1)
  })

  it("pushes again once outside quiet hours", async () => {
    let nowMs = at(23, 0).getTime()
    const { push, service } = makeHarness(() => new Date(nowMs))
    await service.updatePrefs(U, { quietHours: { start: "22:00", end: "07:00", tz: "UTC" } })
    await service.createNotification(U, { type: "system", title: "late" })
    await flushNotificationDispatch()
    expect(push.sent).toHaveLength(0)
    nowMs = at(12, 0).getTime()
    await service.createNotification(U, { type: "system", title: "noon" })
    await flushNotificationDispatch()
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
    await flushNotificationDispatch()
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

describe("markRead (F085: no silent truncation)", () => {
  it("marks EVERY id in a large batch read, not just the first 50", async () => {
    const { repo, service } = makeHarness()
    const ids: string[] = []
    for (let i = 0; i < 120; i++) {
      const n = await repo.insertNotification({
        userId: U,
        type: "system",
        title: `n${i}`,
        body: null,
        link: null,
      })
      ids.push(n.id)
    }
    await service.markRead(U, ids)
    const unread = repo.notifications.filter((n) => n.userId === U && n.readAt === null)
    expect(unread).toHaveLength(0)
  })
})

describe("unregisterPushToken (F083)", () => {
  it("soft-revokes ONLY the caller's own (platform, token) row", async () => {
    const { repo, service } = makeHarness()
    await service.registerPushToken(U, { platform: "ios", token: TOK_U })
    await service.registerPushToken(V, { platform: "ios", token: TOK_V })

    const res = await service.unregisterPushToken(U, { platform: "ios", token: TOK_U })
    expect(res).toEqual({ ok: true })

    expect(repo.pushTokens.find((t) => t.token === TOK_U)?.revokedAt).not.toBeNull()
    expect(repo.pushTokens.find((t) => t.token === TOK_V)?.revokedAt).toBeNull()
  })

  it("does NOT revoke another account's token even with a matching token value", async () => {
    const { repo, service } = makeHarness()
    await service.registerPushToken(V, { platform: "ios", token: TOK_SHARED })
    await service.unregisterPushToken(U, { platform: "ios", token: TOK_SHARED })
    expect(repo.pushTokens.find((t) => t.token === TOK_SHARED)?.revokedAt).toBeNull()
  })
})

describe("push token cap per user (F087)", () => {
  it("keeps at most MAX_ACTIVE_PUSH_TOKENS_PER_USER active tokens, revoking the oldest", async () => {
    const { repo, service } = makeHarness()
    const total = MAX_ACTIVE_PUSH_TOKENS_PER_USER + 5
    for (let i = 0; i < total; i++) {
      await service.registerPushToken(U, { platform: "ios", token: capToken(i) })
    }
    const active = repo.pushTokens.filter((t) => t.userId === U && t.revokedAt === null)
    expect(active).toHaveLength(MAX_ACTIVE_PUSH_TOKENS_PER_USER)
    expect(repo.pushTokens.find((t) => t.token === capToken(0))?.revokedAt).not.toBeNull()
    expect(repo.pushTokens.find((t) => t.token === capToken(total - 1))?.revokedAt).toBeNull()
  })
})

describe("toggle-bell de-duplication (F015)", () => {
  it("collapses a like/unlike/like loop from the SAME actor into ONE bell + ONE push", async () => {
    let nowMs = at(12, 0).getTime()
    const { repo, push, service } = makeHarness(() => new Date(nowMs))
    for (let i = 0; i < 4; i++) {
      await service.onPostLike({ recipientId: U, actorName: "Mallory", postId: "p1" })
      nowMs += 1000
    }
    const bells = repo.notifications.filter((n) => n.userId === U && n.type === "post_like")
    expect(bells).toHaveLength(1)
    await flushNotificationDispatch()
    expect(push.sent.filter((p) => p.userId === U)).toHaveLength(1)
  })

  it("a DIFFERENT actor liking the same post still rings (dedupe keys on actor via body)", async () => {
    const { repo, service } = makeHarness(() => at(12, 0))
    await service.onPostLike({ recipientId: U, actorName: "Alice", postId: "p1" })
    await service.onPostLike({ recipientId: U, actorName: "Bob", postId: "p1" })
    const bells = repo.notifications.filter((n) => n.userId === U && n.type === "post_like")
    expect(bells).toHaveLength(2)
  })

  it("re-fires the follow bell once the cooldown window has elapsed", async () => {
    let nowMs = at(12, 0).getTime()
    const { repo, service } = makeHarness(() => new Date(nowMs))
    const follower = {
      id: V,
      displayName: "Alice",
      handle: "alice",
      bio: null,
      followers: 0,
      following: 0,
      verified: false,
      avatarR2Key: null,
      avatarUrl: null,
      socialLinks: null,
      showVolunteerHours: null,
    }
    await service.onNewFollower({ followeeId: U, follower })
    await service.onNewFollower({ followeeId: U, follower })
    expect(repo.notifications.filter((n) => n.type === "new_follower")).toHaveLength(1)
    nowMs += NOTIFICATION_DEDUPE_WINDOW_MS + 1000
    await service.onNewFollower({ followeeId: U, follower })
    expect(repo.notifications.filter((n) => n.type === "new_follower")).toHaveLength(2)
  })
})

describe("account-erasure notification purge (F088)", () => {
  it("hard-deletes every notification row for the erased user, keeping others", async () => {
    const repo = new InMemoryNotificationRepository()
    await repo.insertNotification({ userId: U, type: "dm", title: "Alice", body: "secret", link: "/messages/dm/t1" })
    await repo.insertNotification({ userId: U, type: "system", title: "x", body: null, link: null })
    await repo.insertNotification({ userId: V, type: "system", title: "keep", body: null, link: null })

    await repo.deleteAllNotificationsForUser(U)
    expect(repo.notifications.filter((n) => n.userId === U)).toHaveLength(0)
    expect(repo.notifications.filter((n) => n.userId === V)).toHaveLength(1)
  })
})

describe("FEED_HIDDEN_NOTIFICATION_TYPES pinning (F089)", () => {
  it("equals the literal list encoded in the notifications_feed_idx partial index predicate", () => {
    expect([...FEED_HIDDEN_NOTIFICATION_TYPES].sort()).toEqual(
      ["cleanup_chat", "dm", "group_chat", "report_chat"].sort(),
    )
  })
})
