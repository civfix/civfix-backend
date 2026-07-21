
import { randomUUID } from "node:crypto"
import type {
  NewNotificationArgs,
  NotificationPrefsPatch,
  NotificationPrefsRecord,
  NotificationRecord,
  NotificationRepository,
  PushTokenUpsertOutcome,
} from "../../src/services/notification-service.js"
import { DEFAULT_PREFS, isFeedVisibleType } from "../../src/services/notification-service.js"
import type { NotificationType, PushPlatform } from "@civfix/shared"

export interface StoredPushToken {
  userId: string
  platform: PushPlatform
  token: string
  deviceId: string | null
  revokedAt: Date | null
}

export class InMemoryNotificationRepository implements NotificationRepository {
  readonly notifications: NotificationRecord[] = []
  readonly prefs = new Map<string, NotificationPrefsRecord>()
  readonly pushTokens: StoredPushToken[] = []

  now: () => Date = () => new Date()
  private seq = 0

  insertNotification(args: NewNotificationArgs): Promise<NotificationRecord> {
    const createdAt = new Date(this.now().getTime() + this.seq)
    this.seq += 1
    const record: NotificationRecord = {
      id: randomUUID(),
      userId: args.userId,
      type: args.type,
      title: args.title,
      body: args.body,
      link: args.link,
      readAt: null,
      createdAt,
    }
    this.notifications.push(record)
    return Promise.resolve(record)
  }

  listNotifications(
    userId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: NotificationRecord[]; nextCursor: string | null }> {
    const mine = this.notifications
      .filter((n) => n.userId === userId && isFeedVisibleType(n.type))
      .sort((a, b) => {
        const cmp = b.createdAt.getTime() - a.createdAt.getTime()
        if (cmp !== 0) return cmp
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
      })

    const parsed = parseTimeCursor(cursor)
    const after =
      parsed !== null
        ? mine.filter((n) => {
            const t = n.createdAt.getTime()
            const ct = parsed.at.getTime()
            if (t !== ct) return t < ct
            return n.id < parsed.id
          })
        : mine

    const hasMore = after.length > limit
    const page = hasMore ? after.slice(0, limit) : after
    const last = page[page.length - 1]
    const nextCursor =
      hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null
    return Promise.resolve({ records: page, nextCursor })
  }

  markRead(userId: string, ids: string[]): Promise<void> {
    const set = new Set(ids)
    const at = this.now()
    for (const n of this.notifications) {
      if (n.userId === userId && set.has(n.id) && n.readAt === null) {
        n.readAt = at
      }
    }
    return Promise.resolve()
  }

  clearByTypeAndLink(userId: string, type: NotificationType, link: string): Promise<void> {
    const at = this.now()
    for (const n of this.notifications) {
      if (n.userId === userId && n.type === type && n.link === link && n.readAt === null) {
        n.readAt = at
      }
    }
    return Promise.resolve()
  }

  findPrefs(userId: string): Promise<NotificationPrefsRecord | null> {
    return Promise.resolve(this.prefs.get(userId) ?? null)
  }

  createDefaultPrefs(userId: string): Promise<NotificationPrefsRecord> {
    const existing = this.prefs.get(userId)
    if (existing) return Promise.resolve(existing)
    const row: NotificationPrefsRecord = { ...DEFAULT_PREFS }
    this.prefs.set(userId, row)
    return Promise.resolve(row)
  }

  upsertPrefs(userId: string, patch: NotificationPrefsPatch): Promise<NotificationPrefsRecord> {
    const current = this.prefs.get(userId) ?? { ...DEFAULT_PREFS }
    const next: NotificationPrefsRecord = {
      push: patch.push ?? current.push,
      cleanupChat: patch.cleanupChat ?? current.cleanupChat,
      reportUpdates: patch.reportUpdates ?? current.reportUpdates,
      follows: patch.follows ?? current.follows,
      mentions: patch.mentions ?? current.mentions,
      postInteractions: patch.postInteractions ?? current.postInteractions,
      quietStart:
        patch.quietHours === undefined
          ? current.quietStart
          : patch.quietHours === null
            ? null
            : patch.quietHours.start,
      quietEnd:
        patch.quietHours === undefined
          ? current.quietEnd
          : patch.quietHours === null
            ? null
            : patch.quietHours.end,
    }
    this.prefs.set(userId, next)
    return Promise.resolve(next)
  }

  upsertPushToken(args: {
    userId: string
    platform: PushPlatform
    token: string
    deviceId: string | null
  }): Promise<PushTokenUpsertOutcome> {
    const existing = this.pushTokens.find(
      (t) => t.platform === args.platform && t.token === args.token,
    )
    if (existing) {
      const owner = existing.userId === args.userId
      const sameDevice = args.deviceId !== null && existing.deviceId === args.deviceId
      if (!owner && !sameDevice) {
        return Promise.resolve("conflict")
      }
      existing.userId = args.userId
      existing.deviceId = args.deviceId
      existing.revokedAt = null
      return Promise.resolve("stored")
    }
    this.pushTokens.push({
      userId: args.userId,
      platform: args.platform,
      token: args.token,
      deviceId: args.deviceId,
      revokedAt: null,
    })
    return Promise.resolve("stored")
  }

  revokeDeviceTokensForOtherUsers(userId: string, deviceId: string): Promise<void> {
    // Mirror the Drizzle UPDATE: soft-revoke active rows on this device owned by a DIFFERENT user.
    for (const t of this.pushTokens) {
      if (t.deviceId === deviceId && t.userId !== userId && t.revokedAt === null) {
        t.revokedAt = this.now()
      }
    }
    return Promise.resolve()
  }

  deletePushTokensForUser(userId: string): Promise<void> {
    for (let i = this.pushTokens.length - 1; i >= 0; i--) {
      if (this.pushTokens[i]!.userId === userId) this.pushTokens.splice(i, 1)
    }
    return Promise.resolve()
  }

  readonly locales = new Map<string, string>()

  findUserLocale(userId: string): Promise<string | null> {
    return Promise.resolve(this.locales.get(userId) ?? null)
  }
}

function parseTimeCursor(cursor: string | null): { at: Date; id: string } | null {
  if (cursor === null) return null
  const idx = cursor.indexOf("|")
  if (idx <= 0) return null
  const iso = cursor.slice(0, idx)
  const id = cursor.slice(idx + 1)
  const at = new Date(iso)
  if (Number.isNaN(at.getTime()) || id.length === 0) return null
  return { at, id }
}
