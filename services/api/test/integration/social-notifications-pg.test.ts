
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { flushNotificationDispatch } from "../helpers/notifications.js"
import { makeDrizzleSocialRepository } from "../../src/services/social-repository.drizzle.js"
import { makeDrizzleNotificationRepository } from "../../src/services/notification-repository.drizzle.js"
import { makeSocialService } from "../../src/services/social-service.js"
import { makeNotificationService } from "../../src/services/notification-service.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { HOST_EVENTS_WINDOW_SEC, makeCleanupService } from "../../src/services/cleanup-service.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"

const pg = await withPg()

const HOST_EVENT_BUDGET_WINDOW_MS = HOST_EVENTS_WINDOW_SEC * 1000

describe.skipIf(!pg)("social + notifications (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string, handle?: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${handle ?? testHandle()}) RETURNING id
    `
    return u!.id
  }

  it("listPeople: excludes viewer, filters by q, reports isFollowing + counts", async () => {
    const repo = makeDrizzleSocialRepository(h.sql)
    const alice = await newUser("Alice Zephyr", "alicez")
    const bob = await newUser("Bob Zephyr", "bobz")
    const carol = await newUser("Carol Other", "carol")
    await repo.addFollow(alice, bob)

    const service = makeSocialService({ repo })
    const res = await service.listPeople({ q: "Zephyr", limit: 50 }, { userId: alice })
    const ids = res.items.map((p) => p.id)
    expect(ids).toContain(bob)
    expect(ids).not.toContain(alice)
    expect(ids).not.toContain(carol)
    const bobItem = res.items.find((p) => p.id === bob)!
    expect(bobItem.isFollowing).toBe(true)
    expect(bobItem.followers).toBe(1)
    expect(bobItem.avatar).toHaveLength(2)
  })

  it("L13: listFollowers / listFollowing hide a blocked account in BOTH directions", async () => {
    const repo = makeDrizzleSocialRepository(h.sql)
    const viewer = await newUser("Block Viewer", "blkview")
    const blockedByViewer = await newUser("Aaa Blocked", "blkbyv")
    const blockerOfViewer = await newUser("Bbb Blocker", "blkofv")
    const innocent = await newUser("Ccc Innocent", "blkinn")
    const subject = await newUser("Ddd Subject", "blksubj")

    for (const u of [blockedByViewer, blockerOfViewer, innocent]) {
      await repo.addFollow(u, subject)
      await repo.addFollow(subject, u)
    }
    await h.sql`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${viewer}, ${blockedByViewer})`
    await h.sql`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${blockerOfViewer}, ${viewer})`

    const followers = await repo.listFollowers({ id: subject, viewerId: viewer, cursor: null, limit: 50 })
    const followerIds = followers.items.map((p) => p.id)
    expect(followerIds).toContain(innocent)
    expect(followerIds).not.toContain(blockedByViewer)
    expect(followerIds).not.toContain(blockerOfViewer)

    const following = await repo.listFollowing({ id: subject, viewerId: viewer, cursor: null, limit: 50 })
    const followingIds = following.items.map((p) => p.id)
    expect(followingIds).toContain(innocent)
    expect(followingIds).not.toContain(blockedByViewer)
    expect(followingIds).not.toContain(blockerOfViewer)

    const anon = await repo.listFollowers({ id: subject, viewerId: null, cursor: null, limit: 50 })
    expect(anon.items.map((p) => p.id)).toEqual(
      expect.arrayContaining([blockedByViewer, blockerOfViewer, innocent]),
    )
  })

  it("follow/unfollow: idempotent, created flag, follower counts", async () => {
    const repo = makeDrizzleSocialRepository(h.sql)
    const a = await newUser("Follower A")
    const b = await newUser("Target B")

    const first = await repo.addFollow(a, b)
    expect(first).toEqual({ exists: true, created: true })
    const again = await repo.addFollow(a, b)
    expect(again).toEqual({ exists: true, created: false })
    expect(await repo.followerCount(b)).toBe(1)

    const removed = await repo.removeFollow(a, b)
    expect(removed).toEqual({ exists: true })
    expect(await repo.followerCount(b)).toBe(0)

    const missing = await repo.addFollow(a, "00000000-0000-0000-0000-000000000000")
    expect(missing.exists).toBe(false)
  })

  it("profile: stats + pastEvents (organized AND attended), recent-first", async () => {
    const socialRepo = makeDrizzleSocialRepository(h.sql)
    const cleanupRepo = makeDrizzleCleanupRepository(h.sql)
    const cleanupService = makeCleanupService({ repo: cleanupRepo })

    const organizer = await newUser("Profile Organizer", "proforg")
    const attendee = await newUser("Profile Attendee", "profatt")

    const older = await cleanupService.createCleanup(
      { title: "Older Sweep", type: "site", eventKind: "cleanup", lat: 34.0, lng: -118.0, scheduledAt: "2025-01-01T10:00:00.000Z" },
      organizer,
    )
    const newer = await cleanupService.createCleanup(
      { title: "Newer Sweep", type: "site", eventKind: "cleanup", lat: 34.1, lng: -118.1, scheduledAt: "2025-03-01T10:00:00.000Z" },
      organizer,
    )
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role)
      VALUES (${older.id}, ${attendee}, 'member')
      ON CONFLICT DO NOTHING
    `

    const socialService = makeSocialService({ repo: socialRepo })

    const orgProfile = (await socialService.getProfile(organizer, { userId: null })).profile
    expect(orgProfile.stats.cleanups).toBe(2)
    expect(orgProfile.pastEvents.map((e) => e.title)).toEqual(["Newer Sweep", "Older Sweep"])

    const attProfile = (await socialService.getProfile(attendee, { userId: null })).profile
    expect(attProfile.stats.cleanups).toBe(0)
    expect(attProfile.pastEvents.map((e) => e.title)).toContain("Older Sweep")
    expect(newer.id).not.toBe(older.id)
  })

  it("profile: an upcoming event the owner HOSTS is public, one they only ATTEND is self-only", async () => {
    const socialRepo = makeDrizzleSocialRepository(h.sql)
    const cleanupService = makeCleanupService({ repo: makeDrizzleCleanupRepository(h.sql) })

    const owner = await newUser("Upcoming Owner", "upcown")
    const stranger = await newUser("Upcoming Stranger", "upcstr")
    const host = await newUser("Upcoming Host", "upchost")

    await cleanupService.createCleanup(
      {
        title: "Hosted Future",
        type: "site",
        eventKind: "cleanup",
        lat: 34.0,
        lng: -118.0,
        scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
      owner,
    )
    const theirs = await cleanupService.createCleanup(
      {
        title: "Someone Elses Future",
        type: "site",
        eventKind: "cleanup",
        lat: 34.2,
        lng: -118.2,
        scheduledAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      },
      host,
    )
    await cleanupService.joinCleanup(theirs.id, owner)

    const socialService = makeSocialService({ repo: socialRepo })

    for (const viewer of [null, stranger]) {
      const seen = (await socialService.getProfile(owner, { userId: viewer })).profile
      expect(seen.upcomingEvents?.map((e) => e.title)).toEqual(["Hosted Future"])
      expect(seen.pastEvents).toEqual([])
    }

    const own = (await socialService.getProfile(owner, { userId: owner })).profile
    expect(own.upcomingEvents?.map((e) => e.title)).toEqual([
      "Someone Elses Future",
      "Hosted Future",
    ])
  })

  it("profile events: the keyset cursor walks every past event exactly once and terminates", async () => {
    const socialRepo = makeDrizzleSocialRepository(h.sql)
    let hostBudgetClockMs = Date.now()
    const cleanupService = makeCleanupService({
      repo: makeDrizzleCleanupRepository(h.sql),
      counters: new InMemoryCounterStore(() => hostBudgetClockMs),
    })
    const owner = await newUser("Cursor Owner", "curown")

    const total = 23
    for (let i = 0; i < total; i++) {
      hostBudgetClockMs += HOST_EVENT_BUDGET_WINDOW_MS
      await cleanupService.createCleanup(
        {
          title: `Cursor Sweep ${i}`,
          type: "site",
          eventKind: "cleanup",
          lat: 34.0,
          lng: -118.0,
          scheduledAt: new Date(Date.now() - (i + 1) * 86_400_000).toISOString(),
        },
        owner,
      )
    }

    const socialService = makeSocialService({ repo: socialRepo })
    const profile = (await socialService.getProfile(owner, { userId: null })).profile
    expect(profile.pastEvents).toHaveLength(20)
    expect(profile.pastEventsCursor).toEqual(expect.any(String))

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await socialService.listProfileEvents(
        owner,
        { userId: null },
        cursor !== undefined ? { cursor } : {},
      )
      for (const item of page.items) seen.push(item.id)
      cursor = page.nextCursor ?? undefined
      pages++
      expect(pages).toBeLessThan(6)
    } while (cursor !== undefined)

    expect(seen).toHaveLength(total)
    expect(new Set(seen).size).toBe(total)
    expect(seen.slice(0, 20)).toEqual(profile.pastEvents.map((e) => e.id))
  })

  it("notifications: insert + newest-first paging + markRead own-only", async () => {
    const repo = makeDrizzleNotificationRepository(h.sql)
    const user = await newUser("Notif User")
    const other = await newUser("Notif Other")

    const n1 = await repo.insertNotification({
      userId: user,
      type: "system",
      title: "first",
      body: null,
      link: null,
    })
    const n2 = await repo.insertNotification({
      userId: user,
      type: "system",
      title: "second",
      body: "b",
      link: "/l",
    })
    const foreign = await repo.insertNotification({
      userId: other,
      type: "system",
      title: "foreign",
      body: null,
      link: null,
    })
    await repo.insertNotification({
      userId: user,
      type: "report_chat",
      title: "hidden",
      body: null,
      link: null,
    })

    const list = await repo.listNotifications(user, null, 50)
    expect(list.records.map((r) => r.title)).toEqual(["second", "first"])

    await repo.markRead(user, [n1.id, foreign.id])
    const after = await repo.listNotifications(user, null, 50)
    expect(after.records.find((r) => r.id === n1.id)!.readAt).not.toBeNull()
    expect(after.records.find((r) => r.id === n2.id)!.readAt).toBeNull()
    const otherList = await repo.listNotifications(other, null, 50)
    expect(otherList.records.find((r) => r.id === foreign.id)!.readAt).toBeNull()
  })

  it("prefs: default-create, partial upsert, quiet-hours set/clear", async () => {
    const repo = makeDrizzleNotificationRepository(h.sql)
    const user = await newUser("Prefs User")

    expect(await repo.findPrefs(user)).toBeNull()
    const created = await repo.createDefaultPrefs(user)
    expect(created).toEqual({
      push: true,
      cleanupChat: true,
      reportUpdates: true,
      follows: true,
      mentions: true,
      postInteractions: true,
      hostBroadcasts: true,
      quietStart: null,
      quietEnd: null,
      tz: null,
    })

    const patched = await repo.upsertPrefs(user, { follows: false })
    expect(patched.follows).toBe(false)
    expect(patched.push).toBe(true)
    expect(patched.mentions).toBe(true)

    const muted = await repo.upsertPrefs(user, { mentions: false })
    expect(muted.mentions).toBe(false)
    expect((await repo.upsertPrefs(user, { push: true })).mentions).toBe(false)

    const withQuiet = await repo.upsertPrefs(user, {
      quietHours: { start: "22:00", end: "07:00" },
    })
    expect(withQuiet.quietStart).toMatch(/^22:00/)
    expect(withQuiet.quietEnd).toMatch(/^07:00/)

    const cleared = await repo.upsertPrefs(user, { quietHours: null })
    expect(cleared.quietStart).toBeNull()
    expect(cleared.quietEnd).toBeNull()
  })

  it("push tokens: owner re-register re-activates; foreign user CANNOT hijack; device_id does NOT authorize a cross-account rebind (F153)", async () => {
    const repo = makeDrizzleNotificationRepository(h.sql)
    const userA = await newUser("Token Owner A")
    const userB = await newUser("Token Owner B")

    expect(await repo.upsertPushToken({ userId: userA, platform: "ios", token: "tok-int", deviceId: "d1" })).toBe(
      "stored",
    )
    await h.sql`UPDATE push_tokens SET revoked_at = now() WHERE token = ${"tok-int"}`

    expect(await repo.upsertPushToken({ userId: userB, platform: "ios", token: "tok-int", deviceId: "d2" })).toBe(
      "conflict",
    )
    let rows = await h.sql<{ user_id: string; device_id: string | null; revoked_at: Date | null }[]>`
      SELECT user_id, device_id, revoked_at FROM push_tokens WHERE platform = 'ios' AND token = ${"tok-int"}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.user_id).toBe(userA)
    expect(rows[0]!.device_id).toBe("d1")
    expect(rows[0]!.revoked_at).not.toBeNull()

    expect(await repo.upsertPushToken({ userId: userA, platform: "ios", token: "tok-int", deviceId: "d1" })).toBe(
      "stored",
    )
    rows = await h.sql<{ user_id: string; device_id: string | null; revoked_at: Date | null }[]>`
      SELECT user_id, device_id, revoked_at FROM push_tokens WHERE platform = 'ios' AND token = ${"tok-int"}
    `
    expect(rows[0]!.user_id).toBe(userA)
    expect(rows[0]!.revoked_at).toBeNull()

    expect(await repo.upsertPushToken({ userId: userB, platform: "ios", token: "tok-int", deviceId: "d1" })).toBe(
      "conflict",
    )
    rows = await h.sql<{ user_id: string; device_id: string | null; revoked_at: Date | null }[]>`
      SELECT user_id, device_id, revoked_at FROM push_tokens WHERE platform = 'ios' AND token = ${"tok-int"}
    `
    expect(rows[0]!.user_id).toBe(userA)
  })

  it("new_follower hook end to end: a NEW follow records a notification for the followee", async () => {
    const socialRepo = makeDrizzleSocialRepository(h.sql)
    const notifRepo = makeDrizzleNotificationRepository(h.sql)
    const notifier = makeNotificationService({ repo: notifRepo, pushSender: new FakePushSender() })
    const social = makeSocialService({ repo: socialRepo, notifier })

    const follower = await newUser("Hook Follower", "hookfol")
    const followee = await newUser("Hook Followee", "hookee")

    await social.followPerson(follower, followee)
    const list = await notifRepo.listNotifications(followee, null, 50)
    expect(list.records).toHaveLength(1)
    expect(list.records[0]!.type).toBe("new_follower")
    expect(list.records[0]!.body).toContain("Hook Follower")

    await social.followPerson(follower, followee)
    const list2 = await notifRepo.listNotifications(followee, null, 50)
    expect(list2.records).toHaveLength(1)
  })

  it("F084: findPrefsMany reads the whole recipient set in one query and honours each row's opt-out", async () => {
    const repo = makeDrizzleNotificationRepository(h.sql)
    const optedIn = await newUser("Prefs In")
    const optedOut = await newUser("Prefs Out")
    const noRow = await newUser("Prefs Absent")
    await repo.createDefaultPrefs(optedIn)
    await repo.createDefaultPrefs(optedOut)
    await repo.upsertPrefs(optedOut, { cleanupChat: false })

    const prefs = await repo.findPrefsMany!([optedIn, optedOut, noRow])

    expect(prefs.size).toBe(2)
    expect(prefs.get(optedIn)?.cleanupChat).toBe(true)
    expect(prefs.get(optedOut)?.cleanupChat).toBe(false)
    expect(prefs.has(noRow)).toBe(false)

    const push = new FakePushSender()
    let fanoutReadPrefs = (): void => undefined
    const fanoutPrefsRead = new Promise<void>((resolve) => {
      fanoutReadPrefs = () => resolve()
    })
    const observedRepo: typeof repo = {
      ...repo,
      async findPrefsMany(userIds: string[]) {
        try {
          return await repo.findPrefsMany!(userIds)
        } finally {
          fanoutReadPrefs()
        }
      },
    }

    await makeNotificationService({ repo: observedRepo, pushSender: push }).createNotifications(
      [optedIn, optedOut, noRow],
      {
        type: "group_chat",
        title: "New message",
        body: "Someone posted.",
        link: `/messages/group/${optedIn}`,
      },
    )

    await fanoutPrefsRead
    await flushNotificationDispatch()
    const pushed = new Set(push.sent.map((s) => s.userId))
    expect(pushed.has(optedIn)).toBe(true)
    expect(pushed.has(noRow)).toBe(true)
    expect(pushed.has(optedOut)).toBe(false)
  })
})
