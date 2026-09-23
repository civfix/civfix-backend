import type { NotificationType, PushPlatform, QuietHours } from "@civfix/shared"

export interface NotificationRecord {
  id: string
  userId: string
  type: NotificationType
  title: string
  body: string | null
  link: string | null
  readAt: Date | null
  createdAt: Date
}

export interface NewNotificationArgs {
  userId: string
  type: NotificationType
  title: string
  body: string | null
  link: string | null
}

export interface NotificationPrefsRecord {
  push: boolean
  cleanupChat: boolean
  reportUpdates: boolean
  follows: boolean
  mentions: boolean
  postInteractions: boolean
  hostBroadcasts: boolean
  quietStart: string | null
  quietEnd: string | null
  tz: string | null
}

export interface NotificationPrefsPatch {
  push?: boolean
  cleanupChat?: boolean
  reportUpdates?: boolean
  follows?: boolean
  mentions?: boolean
  postInteractions?: boolean
  hostBroadcasts?: boolean
  quietHours?: QuietHours | null
}

export interface CoalescedNotificationArgs {
  userId: string
  type: NotificationType
  link: string
  title: string
  body: string | null
  since: Date
}

export interface NotificationRepository {
  insertNotification(args: NewNotificationArgs): Promise<NotificationRecord>

  listNotifications(
    userId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: NotificationRecord[]; nextCursor: string | null }>

  markRead(userId: string, ids: string[]): Promise<void>

  clearByTypeAndLink(userId: string, type: NotificationType, link: string): Promise<void>

  insertUnlessRecentDuplicate(
    args: NewNotificationArgs & { since: Date },
  ): Promise<{ record: NotificationRecord; deduped: boolean }>

  refreshUnreadNotification(args: CoalescedNotificationArgs): Promise<NotificationRecord | null>

  upsertCoalescedNotification(
    args: CoalescedNotificationArgs,
  ): Promise<{ record: NotificationRecord; coalesced: boolean }>

  deleteAllNotificationsForUser(userId: string): Promise<void>

  findPrefs(userId: string): Promise<NotificationPrefsRecord | null>

  findPrefsMany?(userIds: string[]): Promise<Map<string, NotificationPrefsRecord>>

  createDefaultPrefs(userId: string): Promise<NotificationPrefsRecord>

  upsertPrefs(userId: string, patch: NotificationPrefsPatch): Promise<NotificationPrefsRecord>

  upsertPushToken(args: {
    userId: string
    platform: PushPlatform
    token: string
    deviceId: string | null
  }): Promise<PushTokenUpsertOutcome>

  revokeToken(userId: string, platform: PushPlatform, token: string): Promise<void>

  deletePushTokensForUser(userId: string): Promise<void>

  findUserLocale(userId: string): Promise<string | null>

  findUserLocaleMany?(userIds: string[]): Promise<Map<string, string>>
}

export type PushTokenUpsertOutcome = "stored" | "conflict"
