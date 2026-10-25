import { NOTIFICATION_CATEGORY_DEFAULTS } from "@civfix/contract"
import type {
  NotificationCategory,
  NotificationCategorySetting,
  NotificationType,
} from "@civfix/contract"
import type { NotificationSettingRecord } from "./notification-settings-repository.js"

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
