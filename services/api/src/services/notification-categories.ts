import { NOTIFICATION_CATEGORY_DEFAULTS } from "@civfix/contract"
import type {
  NotificationCategory,
  NotificationCategorySetting,
  NotificationType,
} from "@civfix/contract"
import type {
  NotificationSettingRecord,
  NotificationSettingsRepository,
} from "./notification-settings-repository.js"

// D1. A Record, so a type the contract adds does not compile until it is given a category. `null` is
// Always on: transactional notices no setting can turn off.
const CATEGORY_BY_TYPE: Readonly<Record<NotificationType, NotificationCategory | null>> = {
  report_update: "reportUpdates",
  claim_available: "reportUpdates",
  report_chat: "reportDiscussions",
  dm: "directMessages",
  cleanup_chat: "mentions",
  chat_mention: "mentions",
  post_mention: "mentions",
  post_reply: "mentions",
  post_quote: "mentions",
  group_chat: "groupChats",
  cleanup_reminder: "events",
  cleanup_cancelled: "events",
  cleanup_slot: "events",
  event_broadcast: "hostAnnouncements",
  event_team_invite: "eventTeam",
  cleanup_role: "eventTeam",
  hours_logged: "eventTeam",
  new_follower: "followers",
  post_like: "likesAndReposts",
  post_repost: "likesAndReposts",
  org_invite: "organizations",
  system: null,
}

export function categoryForType(type: NotificationType): NotificationCategory | null {
  return CATEGORY_BY_TYPE[type]
}

/** Reads one category's setting from stored rows; a category with no stored row is at its default. */
export function categorySettings(
  records: readonly NotificationSettingRecord[],
  category: NotificationCategory,
): (userId: string) => NotificationCategorySetting {
  const stored = new Map<string, NotificationCategorySetting>()
  for (const r of records) if (r.category === category) stored.set(r.userId, r)
  return (userId) => stored.get(userId) ?? NOTIFICATION_CATEGORY_DEFAULTS[category]
}

export async function categorySettingOf(
  repo: Pick<NotificationSettingsRepository, "getSettings">,
  userId: string,
  category: NotificationCategory,
): Promise<NotificationCategorySetting> {
  return categorySettings(await repo.getSettings(userId), category)(userId)
}

export function emailAllowed(setting: NotificationCategorySetting): boolean {
  return setting.enabled && setting.email
}

/**
 * Whether a path that sends its own email may mail this account holder (D1): only with the category on
 * and Email checked. Without a reader every account is at its default; a failed read mails nothing.
 */
export async function ownEmailAllowed(
  repo: Pick<NotificationSettingsRepository, "getSettings"> | undefined,
  userId: string,
  category: NotificationCategory,
  logger?: { warn?: (obj: unknown, msg?: string) => void },
): Promise<boolean> {
  if (repo === undefined) return emailAllowed(NOTIFICATION_CATEGORY_DEFAULTS[category])
  try {
    return emailAllowed(await categorySettingOf(repo, userId, category))
  } catch (err) {
    logger?.warn?.({ err, category }, "notification settings read failed; the email is not sent")
    return false
  }
}

/** Many users' setting for one category from one read; `null` for each when it is Always on. */
export async function categorySettingsOfMany(
  repo: Pick<NotificationSettingsRepository, "getSettingsMany">,
  userIds: readonly string[],
  category: NotificationCategory | null,
): Promise<(userId: string) => NotificationCategorySetting | null> {
  if (category === null || userIds.length === 0) return () => null
  return categorySettings(await repo.getSettingsMany([...userIds]), category)
}
