/**
 * Social + notifications integration test (Docker-gated). Boots against a live PostGIS container (via
 * withPg) and exercises the DB-backed paths the offline suite covers only with in-memory fakes:
 *
 *   - the Drizzle SocialRepository: listPeople (q filter + viewer exclusion + isFollowing + counts +
 *     keyset paging), follow/unfollow idempotency + the `created` flag, follower counts, pastEvents
 *     (organized OR attended, recent-first), and profile stats;
 *   - the Drizzle NotificationRepository: insert + newest-first paging, markRead (own-only), prefs
 *     default-create + partial upsert + quiet-hours set/clear, and push-token upsert/re-activate;
 *   - the full new_follower hook end to end: a NEW follow records a notification row for the followee.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleSocialRepository } from "../../src/services/social-repository.drizzle.js"
import { makeDrizzleNotificationRepository } from "../../src/services/notification-repository.drizzle.js"
import { makeSocialService } from "../../src/services/social-service.js"
import { makeNotificationService } from "../../src/services/notification-service.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeCleanupService } from "../../src/services/cleanup-service.js"

const pg = await withPg()

describe.skipIf(!pg)("social + notifications (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  /** Insert a user and return its id. */
  async function newUser(name: string, handle?: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${handle ?? null}) RETURNING id
    `
    return u!.id
  }

  it("listPeople: excludes viewer, filters by q, reports isFollowing + counts", async () => {
    const repo = makeDrizzleSocialRepository(h.sql)
    const alice = await newUser("Alice Zephyr", "alicez")
    const bob = await newUser("Bob Zephyr", "bobz")
    const carol = await newUser("Carol Other", "carol")
    // alice follows bob.
    await repo.addFollow(alice, bob)

    const service = makeSocialService({ repo })
    const res = await service.listPeople({ q: "Zephyr", limit: 50 }, { userId: alice })
    const ids = res.items.map((p) => p.id)
    expect(ids).toContain(bob)
    expect(ids).not.toContain(alice) // viewer excluded
    expect(ids).not.toContain(carol) // filtered out by q
    const bobItem = res.items.find((p) => p.id === bob)!
    expect(bobItem.isFollowing).toBe(true)
    expect(bobItem.followers).toBe(1)
    expect(bobItem.avatar).toHaveLength(2)
  })

  it("follow/unfollow: idempotent, created flag, follower counts", async () => {
    const repo = makeDrizzleSocialRepository(h.sql)
    const a = await newUser("Follower A")
    const b = await newUser("Target B")

    const first = await repo.addFollow(a, b)
    expect(first).toEqual({ exists: true, created: true })
    const again = await repo.addFollow(a, b)
    expect(again).toEqual({ exists: true, created: false }) // idempotent, no second hook
    expect(await repo.followerCount(b)).toBe(1)

    const removed = await repo.removeFollow(a, b)
    expect(removed).toEqual({ exists: true })
    expect(await repo.followerCount(b)).toBe(0)

    // Unknown followee -> exists:false.
    const missing = await repo.addFollow(a, "00000000-0000-0000-0000-000000000000")
    expect(missing.exists).toBe(false)
  })

  it("profile: stats + pastEvents (organized AND attended), recent-first", async () => {
    const socialRepo = makeDrizzleSocialRepository(h.sql)
    const cleanupRepo = makeDrizzleCleanupRepository(h.sql)
    const cleanupService = makeCleanupService({ repo: cleanupRepo })

    const organizer = await newUser("Profile Organizer", "proforg")
    const attendee = await newUser("Profile Attendee", "profatt")

    // organizer creates two cleanups (different dates).
    const older = await cleanupService.createCleanup(
      { title: "Older Sweep", type: "site", lat: 34.0, lng: -118.0, scheduledAt: "2025-01-01T10:00:00.000Z" },
      organizer,
    )
    const newer = await cleanupService.createCleanup(
      { title: "Newer Sweep", type: "site", lat: 34.1, lng: -118.1, scheduledAt: "2025-03-01T10:00:00.000Z" },
      organizer,
    )
    // attendee joins the older one.
    await cleanupService.joinCleanup(older.id, attendee)

    const socialService = makeSocialService({ repo: socialRepo })

    // Organizer's profile: organized 2, recent-first.
    const orgProfile = (await socialService.getProfile(organizer, { userId: null })).profile
    expect(orgProfile.stats.cleanups).toBe(2)
    expect(orgProfile.pastEvents.map((e) => e.title)).toEqual(["Newer Sweep", "Older Sweep"])

    // Attendee's profile: organized 0 but the attended cleanup shows in pastEvents.
    const attProfile = (await socialService.getProfile(attendee, { userId: null })).profile
    expect(attProfile.stats.cleanups).toBe(0)
    expect(attProfile.pastEvents.map((e) => e.title)).toContain("Older Sweep")
    expect(newer.id).not.toBe(older.id)
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

    const list = await repo.listNotifications(user, null, 50)
    expect(list.records.map((r) => r.title)).toEqual(["second", "first"])

    // markRead only the user's own; a foreign id is ignored.
    await repo.markRead(user, [n1.id, foreign.id])
    const after = await repo.listNotifications(user, null, 50)
    expect(after.records.find((r) => r.id === n1.id)!.readAt).not.toBeNull()
    expect(after.records.find((r) => r.id === n2.id)!.readAt).toBeNull()
    // The foreign row stays unread.
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
      quietStart: null,
      quietEnd: null,
    })

    // Partial upsert leaves others intact.
    const patched = await repo.upsertPrefs(user, { follows: false })
    expect(patched.follows).toBe(false)
    expect(patched.push).toBe(true)

    // Set quiet hours (the time columns round-trip as strings).
    const withQuiet = await repo.upsertPrefs(user, {
      quietHours: { start: "22:00", end: "07:00" },
    })
    expect(withQuiet.quietStart).toMatch(/^22:00/)
    expect(withQuiet.quietEnd).toMatch(/^07:00/)

    // Clear them.
    const cleared = await repo.upsertPrefs(user, { quietHours: null })
    expect(cleared.quietStart).toBeNull()
    expect(cleared.quietEnd).toBeNull()
  })

  it("push tokens: upsert keyed on (platform, token) re-activates a revoked token", async () => {
    const repo = makeDrizzleNotificationRepository(h.sql)
    const userA = await newUser("Token Owner A")
    const userB = await newUser("Token Owner B")

    await repo.upsertPushToken({ userId: userA, platform: "ios", token: "tok-int", deviceId: "d1" })
    // Revoke it directly.
    await h.sql`UPDATE push_tokens SET revoked_at = now() WHERE token = ${"tok-int"}`

    // Re-register under userB -> re-point + re-activate; still ONE row.
    await repo.upsertPushToken({ userId: userB, platform: "ios", token: "tok-int", deviceId: "d2" })
    const rows = await h.sql<{ user_id: string; device_id: string | null; revoked_at: Date | null }[]>`
      SELECT user_id, device_id, revoked_at FROM push_tokens WHERE platform = 'ios' AND token = ${"tok-int"}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.user_id).toBe(userB)
    expect(rows[0]!.device_id).toBe("d2")
    expect(rows[0]!.revoked_at).toBeNull()
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

    // A re-follow does NOT add a second notification.
    await social.followPerson(follower, followee)
    const list2 = await notifRepo.listNotifications(followee, null, 50)
    expect(list2.records).toHaveLength(1)
  })
})
