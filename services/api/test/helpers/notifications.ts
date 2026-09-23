import { randomUUID } from "node:crypto"
import type {
  CreateNotificationInput,
  NewNotificationArgs,
  NotificationPrefsPatch,
  NotificationPrefsRecord,
  NotificationRecord,
  NotificationRepository,
  PushTokenUpsertOutcome,
} from "../../src/services/notification-service.js"
import { DEFAULT_PREFS, isFeedVisibleType } from "../../src/services/notification-service.js"
import { MAX_ACTIVE_PUSH_TOKENS_PER_USER } from "../../src/services/notification-repository.drizzle.js"
import { paginate, parseTimeCursor } from "../../src/db/cursor-helpers.js"
import type { NotificationDTO, NotificationType, PushPlatform } from "@civfix/shared"
import type { ReporterNotifier } from "../../src/services/admin/admin-report-service.js"

export interface RecordedNotification extends CreateNotificationInput {
  userId: string
}

export class RecordingNotifier implements ReporterNotifier {
  readonly sent: RecordedNotification[] = []
  failNext = false

  createNotification(userId: string, input: CreateNotificationInput): Promise<NotificationDTO> {
    if (this.failNext) {
      this.failNext = false
      return Promise.reject(new Error("push provider down"))
    }
    this.sent.push({ userId, ...input })
    return Promise.resolve({
      id: `notif-${this.sent.length}`,
      type: input.type,
      title: input.title ?? "",
      body: input.body ?? "",
      link: input.link ?? null,
      read: false,
      createdAt: new Date(0).toISOString(),
    })
  }
}

export function flushNotificationDispatch(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

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

    const { items, nextCursor } = paginate(after, limit, (n) => ({ at: n.createdAt, id: n.id }))
    return Promise.resolve({ records: items, nextCursor })
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
      hostBroadcasts: patch.hostBroadcasts ?? current.hostBroadcasts,
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
      tz:
        patch.quietHours === undefined
          ? current.tz
          : patch.quietHours === null
            ? null
            : (patch.quietHours.tz ?? null),
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
      if (existing.userId !== args.userId && existing.revokedAt === null) {
        return Promise.resolve("conflict")
      }
      existing.userId = args.userId
      existing.deviceId = args.deviceId
      existing.revokedAt = null
      this.pushTokens.splice(this.pushTokens.indexOf(existing), 1)
      this.pushTokens.push(existing)
      this.capActiveTokens(args.userId)
      return Promise.resolve("stored")
    }
    this.pushTokens.push({
      userId: args.userId,
      platform: args.platform,
      token: args.token,
      deviceId: args.deviceId,
      revokedAt: null,
    })
    this.capActiveTokens(args.userId)
    return Promise.resolve("stored")
  }

  private capActiveTokens(userId: string): void {
    const active = this.pushTokens.filter((t) => t.userId === userId && t.revokedAt === null)
    if (active.length <= MAX_ACTIVE_PUSH_TOKENS_PER_USER) return
    const at = this.now()
    for (const t of active.slice(0, active.length - MAX_ACTIVE_PUSH_TOKENS_PER_USER)) {
      t.revokedAt = at
    }
  }

  revokeToken(userId: string, platform: PushPlatform, token: string): Promise<void> {
    for (const t of this.pushTokens) {
      if (
        t.userId === userId &&
        t.platform === platform &&
        t.token === token &&
        t.revokedAt === null
      ) {
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

  findRecentDuplicate(args: {
    userId: string
    type: NotificationType
    link: string | null
    body: string | null
    since: Date
  }): Promise<NotificationRecord | null> {
    const match = this.notifications
      .filter(
        (n) =>
          n.userId === args.userId &&
          n.type === args.type &&
          n.link === args.link &&
          n.body === args.body &&
          n.createdAt.getTime() > args.since.getTime(),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
    return Promise.resolve(match ?? null)
  }

  refreshUnreadNotification(args: {
    userId: string
    type: NotificationType
    link: string
    title: string
    body: string | null
    since: Date
  }): Promise<NotificationRecord | null> {
    const match = this.notifications
      .filter(
        (n) =>
          n.userId === args.userId &&
          n.type === args.type &&
          n.link === args.link &&
          n.readAt === null &&
          n.createdAt.getTime() > args.since.getTime(),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
    if (!match) return Promise.resolve(null)
    match.title = args.title
    match.body = args.body
    return Promise.resolve(match)
  }

  async upsertCoalescedNotification(args: {
    userId: string
    type: NotificationType
    link: string
    title: string
    body: string | null
    since: Date
  }): Promise<{ record: NotificationRecord; coalesced: boolean }> {
    const refreshed = await this.refreshUnreadNotification(args)
    if (refreshed) return { record: refreshed, coalesced: true }
    const record = await this.insertNotification({
      userId: args.userId,
      type: args.type,
      title: args.title,
      body: args.body,
      link: args.link,
    })
    return { record, coalesced: false }
  }

  deleteAllNotificationsForUser(userId: string): Promise<void> {
    for (let i = this.notifications.length - 1; i >= 0; i--) {
      if (this.notifications[i]!.userId === userId) this.notifications.splice(i, 1)
    }
    return Promise.resolve()
  }

  readonly locales = new Map<string, string>()

  readonly localeCalls: string[] = []
  readonly localeBatchCalls: number[] = []

  findUserLocale(userId: string): Promise<string | null> {
    this.localeCalls.push(userId)
    return Promise.resolve(this.locales.get(userId) ?? null)
  }

  findUserLocaleMany(userIds: string[]): Promise<Map<string, string>> {
    this.localeBatchCalls.push(userIds.length)
    const out = new Map<string, string>()
    for (const userId of userIds) {
      const locale = this.locales.get(userId)
      if (locale !== undefined) out.set(userId, locale)
    }
    return Promise.resolve(out)
  }
}
