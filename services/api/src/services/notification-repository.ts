import type { NotificationType, PushPlatform, QuietHours } from "@civfix/contract"

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

/** The person a listed notification is about, as the viewer may see them. */
export interface NotificationActorRecord {
  id: string
  displayName: string
  handle: string | null
  /** Already resolved the way every user avatar is (user-avatar.ts). */
  avatarUrl: string | null
  isFollowing: boolean
}

export interface ListedNotificationRecord extends NotificationRecord {
  /** Null when the row has no actor, the actor's account is deleted, or either blocks the other. */
  actor: NotificationActorRecord | null
}

export interface NewNotificationArgs {
  userId: string
  type: NotificationType
  title: string
  body: string | null
  link: string | null
  /** Who the notification is about, when it is about a person. */
  actorId?: string
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

/** A recipient a notification email may go to: a live account whose verified address is not suppressed. */
export interface EmailRecipientRecord {
  userId: string
  email: string
  locale: string
}

export interface NotificationRepository {
  insertNotification(args: NewNotificationArgs): Promise<NotificationRecord>

  listNotifications(
    userId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: ListedNotificationRecord[]; nextCursor: string | null }>

  markRead(userId: string, ids: string[]): Promise<string[]>

  // Also reads the room's chat_mention rows: they carry the room's bell link.
  clearByTypeAndLink(userId: string, type: NotificationType, link: string): Promise<string[]>

  hasUnread(userId: string): Promise<boolean>

  markAllRead(userId: string): Promise<number>

  deleteNotification(userId: string, id: string): Promise<boolean>

  /** Which of these users already have a notification of this type and link since the given time. */
  usersNotifiedSince(args: {
    userIds: readonly string[]
    type: NotificationType
    link: string
    since: Date
  }): Promise<string[]>

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

  findEmailRecipients(userIds: string[]): Promise<EmailRecipientRecord[]>
}

export type PushTokenUpsertOutcome = "stored" | "conflict"
