// GH#215: every recipient's push names that recipient's own notification row, and an Expo-format token
// is refused at registration.

import { describe, expect, it, vi } from "vitest"
import { AppError } from "@civfix/contract"
import type { PushItem, PushPayload, PushSender } from "@civfix/seams"
import {
  PUSH_FANOUT_BATCH_SIZE,
  makeNotificationService,
} from "../../src/services/notification-service.js"
import {
  InMemoryNotificationRepository,
  InMemoryNotificationSettingsRepository,
  flushNotificationDispatch,
} from "../helpers/notifications.js"

class RecordingPushSender implements PushSender {
  readonly singles: PushItem[] = []
  readonly batches: PushItem[][] = []

  registerToken(): Promise<void> {
    return Promise.resolve()
  }

  send(userId: string, payload: PushPayload): Promise<void> {
    this.singles.push({ userId, payload })
    return Promise.resolve()
  }

  sendEach(items: PushItem[]): Promise<void> {
    this.batches.push(items)
    return Promise.resolve()
  }

  clear(): Promise<void> {
    return Promise.resolve()
  }
}

function harness() {
  const repo = new InMemoryNotificationRepository()
  const settings = new InMemoryNotificationSettingsRepository()
  const push = new RecordingPushSender()
  const service = makeNotificationService({ repo, settingsRepo: settings, pushSender: push })
  return { repo, settings, push, service }
}

// Report discussions default to in-app only (D1), so these recipients check Push.
async function pushReportDiscussions(
  settings: InMemoryNotificationSettingsRepository,
  userIds: string[],
): Promise<void> {
  for (const userId of userIds) {
    await settings.upsertSettings(userId, { reportDiscussions: { push: true } })
  }
}

function rowIdOf(repo: InMemoryNotificationRepository, userId: string): string {
  const rows = repo.notifications.filter((n) => n.userId === userId)
  expect(rows).toHaveLength(1)
  return rows[0]!.id
}

function user(i: number): string {
  return `00000000-0000-4000-a000-${String(i).padStart(12, "0")}`
}

describe("NotificationService push payloads per recipient", () => {
  it("T3: a two-recipient fan-out sends one sendEach with each recipient's own row id", async () => {
    const { repo, settings, push, service } = harness()
    const u1 = user(1)
    const u2 = user(2)
    await pushReportDiscussions(settings, [u1, u2])

    await service.createNotifications([u1, u2], {
      type: "report_chat",
      title: "New message",
      body: "Someone wrote in the report chat",
      link: "/reports/r1",
    })
    await flushNotificationDispatch()

    expect(push.batches).toHaveLength(1)
    const batch = push.batches[0]!
    expect(batch).toHaveLength(2)
    const byUser = new Map(batch.map((item) => [item.userId, item]))
    expect(byUser.get(u1)!.payload.notificationId).toBe(rowIdOf(repo, u1))
    expect(byUser.get(u2)!.payload.notificationId).toBe(rowIdOf(repo, u2))
    expect(byUser.get(u1)!.payload.notificationId).not.toBe(byUser.get(u2)!.payload.notificationId)
  })

  it("T4: 250 recipients go out as sendEach batches of 100, 100 and 50, each with its own row id", async () => {
    const { repo, settings, push, service } = harness()
    const recipients = Array.from({ length: 250 }, (_, i) => user(i))
    await pushReportDiscussions(settings, recipients)

    await service.createNotifications(recipients, {
      type: "report_chat",
      title: "New message",
      body: "Someone wrote in the report chat",
      link: "/reports/r1",
    })
    await flushNotificationDispatch()

    expect(PUSH_FANOUT_BATCH_SIZE).toBe(100)
    expect(push.batches.map((b) => b.length)).toEqual([100, 100, 50])
    for (const item of push.batches.flat()) {
      expect(item.payload.notificationId).toBe(rowIdOf(repo, item.userId))
    }
  })

  it("T5: a single notification's push carries the returned row id and its type", async () => {
    const { push, service } = harness()
    const u1 = user(1)

    const dto = await service.createNotification(u1, {
      type: "report_update",
      title: "Status changed",
      body: "Your report is in progress",
      link: "/reports/r1",
    })
    await flushNotificationDispatch()

    const pushes = [...push.singles, ...push.batches.flat()]
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.userId).toBe(u1)
    expect(pushes[0]!.payload.notificationId).toBe(dto!.id)
    expect(pushes[0]!.payload.type).toBe("report_update")
  })
})

describe("NotificationService.registerPushToken refuses Expo tokens", () => {
  it("T25: an Expo-format token on ios or android is a VALIDATION error on token, never stored", async () => {
    const { repo, service } = harness()
    const upsert = vi.spyOn(repo, "upsertPushToken")

    for (const req of [
      { platform: "ios" as const, token: "ExponentPushToken[abcdefghijklmnop]" },
      { platform: "android" as const, token: "ExpoPushToken[abcdefghijklmnop]" },
    ]) {
      const err = await service.registerPushToken(user(1), req).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(AppError)
      const appErr = err as AppError
      expect(appErr.code).toBe("VALIDATION")
      expect(appErr.message).toBe("Invalid push token")
      expect(appErr.fields).toMatchObject({ token: expect.any(String) })
    }
    expect(upsert).not.toHaveBeenCalled()
  })
})
