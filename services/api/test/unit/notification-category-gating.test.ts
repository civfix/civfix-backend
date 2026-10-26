// GH#221 / D2: a notification's category setting decides its row and its push. Off writes nothing,
// pushes nothing and signals nothing; on writes the row and pushes only when Push is checked, still
// subject to quiet hours. A category with no stored row is at NOTIFICATION_CATEGORY_DEFAULTS.

import { describe, expect, it, vi } from "vitest"
import { FakePushSender, FakeUserChannel } from "@civfix/seams"
import { NotificationCategorySchema } from "@civfix/contract"
import type { NotificationCategory } from "@civfix/contract"
import { DEFAULT_PREFS, makeNotificationService } from "../../src/services/notification-service.js"
import {
  InMemoryNotificationRepository,
  InMemoryNotificationSettingsRepository,
  flushNotificationDispatch,
} from "../helpers/notifications.js"

const NOW = new Date("2026-10-24T12:00:00Z")

const A = "aaaaaaaa-0000-4000-8000-000000000001"
const B = "bbbbbbbb-0000-4000-8000-000000000002"
const C = "cccccccc-0000-4000-8000-000000000003"

type Setting = [enabled: boolean, push: boolean, email: boolean]

function user(i: number): string {
  return `00000000-0000-4000-a000-${String(i).padStart(12, "0")}`
}

function users(n: number): string[] {
  return Array.from({ length: n }, (_, i) => user(i))
}

function harness() {
  const repo = new InMemoryNotificationRepository()
  repo.now = () => NOW
  const settings = new InMemoryNotificationSettingsRepository()
  settings.now = () => NOW
  const push = new FakePushSender()
  const channel = new FakeUserChannel()
  const service = makeNotificationService({
    repo,
    settingsRepo: settings,
    pushSender: push,
    userChannel: channel,
    now: () => NOW,
  })

  async function set(userId: string, category: NotificationCategory, s: Setting): Promise<void> {
    const [enabled, pushOn, email] = s
    await settings.upsertSettings(userId, { [category]: { enabled, push: pushOn, email } })
  }

  async function setAll(userId: string, s: Setting): Promise<void> {
    for (const category of NotificationCategorySchema.options) await set(userId, category, s)
  }

  function quietNoon(userId: string): void {
    repo.prefs.set(userId, { ...DEFAULT_PREFS, quietStart: "11:00", quietEnd: "13:00", tz: "UTC" })
  }

  const rows = (userId?: string) =>
    repo.notifications.filter((n) => userId === undefined || n.userId === userId)
  const pushItems = () => push.sent
  const signals = () => channel.published.filter((p) => p.signal.topic === "notifications")
  const signalled = () => signals().map((p) => p.userId)

  return {
    repo,
    settings,
    push,
    channel,
    service,
    set,
    setAll,
    quietNoon,
    rows,
    pushItems,
    signals,
    signalled,
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await flushNotificationDispatch()
}

describe("createNotification gated by category settings", () => {
  it("T3: an Off category writes no row, pushes nothing, signals nothing and resolves null", async () => {
    const h = harness()
    await h.set(A, "likesAndReposts", [false, true, false])

    const result = await h.service.createNotification(A, { type: "post_like", title: "Liked" })
    await settle()

    expect(result).toBeNull()
    expect(h.rows(A)).toHaveLength(0)
    expect(h.pushItems()).toHaveLength(0)
    expect(h.signals()).toHaveLength(0)
  })

  it("T4: a default in-app category writes the row and signals, with no push", async () => {
    const h = harness()

    const result = await h.service.createNotification(A, { type: "post_like", title: "Liked" })
    await settle()

    expect(result).toMatchObject({ type: "post_like", read: false })
    expect(h.rows(A)).toHaveLength(1)
    expect(h.pushItems()).toHaveLength(0)
    expect(h.signalled()).toEqual([A])
  })

  it("T5: Push checked sends one push naming the row, its type and its category", async () => {
    const h = harness()
    await h.set(A, "followers", [true, true, false])

    await h.service.createNotification(A, { type: "new_follower", title: "New follower" })
    await settle()

    expect(h.rows(A)).toHaveLength(1)
    expect(h.pushItems()).toHaveLength(1)
    const [item] = h.pushItems()
    expect(item!.userId).toBe(A)
    expect(item!.payload).toMatchObject({
      notificationId: h.rows(A)[0]!.id,
      type: "new_follower",
      category: "followers",
    })
    expect(h.signals()).toHaveLength(1)
  })

  it("T6: Push unchecked writes the row and sends no push", async () => {
    const h = harness()
    await h.set(A, "directMessages", [true, false, false])

    await h.service.createNotification(A, { type: "dm", title: "Ana" })
    await settle()

    expect(h.rows(A)).toHaveLength(1)
    expect(h.pushItems()).toHaveLength(0)
  })

  it("T7: the old notification_prefs booleans no longer gate the row or the push", async () => {
    const h = harness()
    h.repo.prefs.set(A, { ...DEFAULT_PREFS, push: false, follows: false, postInteractions: false })
    await h.set(A, "followers", [true, true, false])

    await h.service.createNotification(A, { type: "new_follower", title: "New follower" })
    await settle()

    expect(h.rows(A)).toHaveLength(1)
    expect(h.pushItems().filter((p) => p.userId === A)).toHaveLength(1)

    h.repo.prefs.set(B, { ...DEFAULT_PREFS })
    await h.set(B, "likesAndReposts", [false, false, false])

    const result = await h.service.createNotification(B, { type: "post_like", title: "Liked" })
    await settle()

    expect(result).toBeNull()
    expect(h.rows(B)).toHaveLength(0)
    expect(h.pushItems().filter((p) => p.userId === B)).toHaveLength(0)
  })

  it("T8: quiet hours still hold back a push the category allows", async () => {
    const h = harness()
    h.quietNoon(A)
    await h.set(A, "followers", [true, true, false])

    await h.service.createNotification(A, { type: "new_follower", title: "New follower" })
    await settle()

    expect(h.rows(A)).toHaveLength(1)
    expect(h.pushItems()).toHaveLength(0)
  })

  it("T9: an Always on type ignores every category being Off", async () => {
    const h = harness()
    await h.setAll(A, [false, false, false])

    const result = await h.service.createNotification(A, {
      type: "system",
      title: "You're registered",
    })
    await settle()

    expect(result).toMatchObject({ type: "system" })
    expect(h.rows(A)).toHaveLength(1)
    expect(h.pushItems()).toHaveLength(1)
    expect(h.pushItems()[0]!.payload.category).toBeNull()
    expect(h.signals()).toHaveLength(1)
  })

  it("T10: a category override that is Off writes nothing for an Always on type", async () => {
    const h = harness()
    await h.set(A, "organizations", [false, true, true])

    const result = await h.service.createNotification(A, {
      type: "system",
      title: "Verified",
      category: "organizations",
    })
    await settle()

    expect(result).toBeNull()
    expect(h.rows(A)).toHaveLength(0)
    expect(h.pushItems()).toHaveLength(0)
    expect(h.signals()).toHaveLength(0)
  })

  it("T11: a category override that is on with Push writes a system row and pushes its category", async () => {
    const h = harness()
    await h.set(A, "organizations", [true, true, false])

    await h.service.createNotification(A, {
      type: "system",
      title: "Verified",
      category: "organizations",
    })
    await settle()

    expect(h.rows(A).map((n) => n.type)).toEqual(["system"])
    expect(h.pushItems()).toHaveLength(1)
    expect(h.pushItems()[0]!.payload.category).toBe("organizations")
  })

  it("T12: a category override beats the type's own category", async () => {
    const h = harness()
    await h.set(A, "likesAndReposts", [false, false, false])
    await h.set(A, "followers", [true, true, false])

    await h.service.createNotification(A, {
      type: "post_like",
      title: "Liked",
      category: "followers",
    })
    await settle()

    expect(h.rows(A)).toHaveLength(1)
    expect(h.pushItems()).toHaveLength(1)
    expect(h.pushItems()[0]!.payload.category).toBe("followers")
  })

  it('T13: push "never" sends no push even with Push checked', async () => {
    const h = harness()
    await h.set(A, "followers", [true, true, false])

    await h.service.createNotification(A, {
      type: "new_follower",
      title: "New follower",
      push: "never",
    })
    await settle()

    expect(h.rows(A)).toHaveLength(1)
    expect(h.pushItems()).toHaveLength(0)
  })

  it("T15: a dedupe hit pushes and signals nothing more", async () => {
    const h = harness()
    await h.set(A, "followers", [true, true, false])
    const input = {
      type: "new_follower" as const,
      title: "New follower",
      link: "/people/x",
      dedupeWindowMs: 300_000,
    }

    await h.service.createNotification(A, input)
    await h.service.createNotification(A, input)
    await settle()

    expect(h.rows(A)).toHaveLength(1)
    expect(h.pushItems()).toHaveLength(1)
    expect(h.signals()).toHaveLength(1)
  })

  it("T16: an unreadable setting rejects the call before any row is written", async () => {
    const h = harness()
    h.settings.getSettings = () => Promise.reject(new Error("settings store down"))

    await expect(
      h.service.createNotification(A, { type: "new_follower", title: "New follower" }),
    ).rejects.toThrow("settings store down")
    await settle()

    expect(h.rows(A)).toHaveLength(0)
    expect(h.pushItems()).toHaveLength(0)
  })

  it("T17: email and conversationName change nothing about the row or the push", async () => {
    const h = harness()

    await h.service.createNotification(A, { type: "dm", title: "Ana" })
    await h.service.createNotification(A, {
      type: "dm",
      title: "Ana",
      email: "never",
      conversationName: "Ana",
    })
    await h.service.createNotification(A, { type: "dm", title: "Ana", email: "auto" })
    await settle()

    const shape = h.rows(A).map(({ type, title, body, link }) => ({ type, title, body, link }))
    expect(shape).toHaveLength(3)
    expect(shape[1]).toEqual(shape[0])
    expect(shape[2]).toEqual(shape[0])
    expect(h.pushItems()).toHaveLength(3)
  })
})

describe("fan-outs gated by category settings", () => {
  async function evenOff(h: ReturnType<typeof harness>, recipients: string[]): Promise<void> {
    for (const [i, u] of recipients.entries()) {
      if (i % 2 === 0) await h.set(u, "likesAndReposts", [false, true, false])
    }
  }

  it("T18: 2000 recipients, half Off: rows and signals for the on half only, no failures", async () => {
    const h = harness()
    const recipients = users(2000)
    await evenOff(h, recipients)
    const odd = recipients.filter((_, i) => i % 2 === 1)

    const result = await h.service.createNotificationsReportingFailures(recipients, {
      type: "post_like",
      title: "Liked",
    })
    await settle()

    expect(result).toEqual({ failed: [] })
    expect(new Set(h.rows().map((n) => n.userId))).toEqual(new Set(odd))
    expect(h.rows()).toHaveLength(1000)
    expect(h.pushItems()).toHaveLength(0)
    expect(new Set(h.signalled())).toEqual(new Set(odd))
  })

  it("T19: settings are read with one getSettingsMany call per 500 recipients", async () => {
    const h = harness()
    const recipients = users(2000)
    await evenOff(h, recipients)
    const many = vi.spyOn(h.settings, "getSettingsMany")
    const single = vi.spyOn(h.settings, "getSettings")

    await h.service.createNotificationsReportingFailures(recipients, {
      type: "post_like",
      title: "Liked",
    })
    await settle()

    expect(many).toHaveBeenCalledTimes(4)
    const asked = many.mock.calls.map(([ids]) => ids)
    for (const ids of asked) {
      expect(ids).toHaveLength(500)
      expect(new Set(ids).size).toBe(500)
    }
    expect(new Set(asked.flat())).toEqual(new Set(recipients))
    expect(single).not.toHaveBeenCalled()
  })

  it("T20: 2000 recipients with Push get 2000 pushes, each naming its own row", async () => {
    const h = harness()
    const recipients = users(2000)
    for (const u of recipients) await h.set(u, "followers", [true, true, false])

    const result = await h.service.createNotificationsReportingFailures(recipients, {
      type: "new_follower",
      title: "New follower",
    })
    await settle()

    expect(result).toEqual({ failed: [] })
    expect(h.rows()).toHaveLength(2000)
    expect(h.pushItems()).toHaveLength(2000)
    expect(new Set(h.pushItems().map((p) => p.userId))).toEqual(new Set(recipients))
    const rowOf = new Map(h.rows().map((n) => [n.userId, n.id]))
    for (const { userId, payload } of h.pushItems()) {
      expect(payload.notificationId).toBe(rowOf.get(userId))
      expect(payload.category).toBe("followers")
    }
  })

  it("T21: an Always on fan-out reaches 2000 recipients with every category Off", async () => {
    const h = harness()
    const recipients = users(2000)
    for (const u of recipients) await h.setAll(u, [false, false, false])

    const result = await h.service.createNotificationsReportingFailures(recipients, {
      type: "system",
      title: "Registered",
    })
    await settle()

    expect(result).toEqual({ failed: [] })
    expect(h.rows()).toHaveLength(2000)
    expect(h.pushItems()).toHaveLength(2000)
    expect(h.pushItems().every((p) => p.payload.category === null)).toBe(true)
  })

  it("T22: one Off recipient of two gets nothing and is not a failure", async () => {
    const h = harness()
    await h.set(A, "hostAnnouncements", [false, true, false])
    await h.set(B, "hostAnnouncements", [true, true, false])

    const result = await h.service.createNotificationsReportingFailures([A, B], {
      type: "event_broadcast",
      title: "Update",
    })
    await settle()

    expect(result).toEqual({ failed: [] })
    expect(h.rows().map((n) => n.userId)).toEqual([B])
    expect(h.pushItems().map((p) => p.userId)).toEqual([B])
    expect(h.signalled()).toEqual([B])
  })

  it("T23: write failures are still reported, and an Off recipient is not one", async () => {
    const h = harness()
    await h.set(A, "likesAndReposts", [false, false, false])
    const insert = h.repo.insertNotification.bind(h.repo)
    h.repo.insertNotification = (args) =>
      args.userId === C ? Promise.reject(new Error("insert failed")) : insert(args)

    const result = await h.service.createNotificationsReportingFailures([A, B, C], {
      type: "post_like",
      title: "Liked",
    })
    await settle()

    expect(result).toEqual({ failed: [C] })
    expect(h.rows(B)).toHaveLength(1)
    expect(h.rows(A)).toHaveLength(0)
  })

  it("T24: a batch whose settings cannot be read fails as a whole, without rows", async () => {
    const h = harness()
    const recipients = users(600)
    const read = h.settings.getSettingsMany.bind(h.settings)
    let calls = 0
    h.settings.getSettingsMany = (ids) => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error("settings store down")) : read(ids)
    }

    const result = await h.service.createNotificationsReportingFailures(recipients, {
      type: "new_follower",
      title: "New follower",
    })
    await settle()

    const first = recipients.slice(0, 500)
    const last = recipients.slice(500)
    expect(result.failed).toEqual(first)
    expect(new Set(h.rows().map((n) => n.userId))).toEqual(new Set(last))
    expect(h.rows()).toHaveLength(100)
    expect(h.pushItems()).toHaveLength(0)
    expect(new Set(h.signalled())).toEqual(new Set(last))
    expect(h.signalled()).toHaveLength(100)
  })

  it("T25: quiet hours hold back one recipient's push in a fan-out", async () => {
    const h = harness()
    await h.set(A, "followers", [true, true, false])
    await h.set(B, "followers", [true, true, false])
    h.quietNoon(A)

    await h.service.createNotificationsReportingFailures([A, B], {
      type: "new_follower",
      title: "New follower",
    })
    await settle()

    expect(h.rows()).toHaveLength(2)
    expect(h.pushItems().map((p) => p.userId)).toEqual([B])
  })

  it("T26: createNotifications skips an Off recipient and resolves undefined", async () => {
    const h = harness()
    await h.set(A, "likesAndReposts", [false, false, false])

    const result = await h.service.createNotifications([A, B], {
      type: "post_like",
      title: "Liked",
    })
    await settle()

    expect(result).toBeUndefined()
    expect(h.rows(B)).toHaveLength(1)
    expect(h.rows(A)).toHaveLength(0)
  })
})
