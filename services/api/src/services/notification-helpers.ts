
import type {
  NotificationDTO,
  NotificationPrefsDTO,
  NotificationType,
} from "@civfix/shared"
import type { NotificationPrefsRecord, NotificationRecord } from "./notification-service.js"

export const DEFAULT_PREFS: NotificationPrefsRecord = {
  push: true,
  cleanupChat: true,
  reportUpdates: true,
  follows: true,
  mentions: true,
  postInteractions: true,
  quietStart: null,
  quietEnd: null,
}

// dm/cleanup_chat/group_chat/report_chat are all private-messaging bells: push + badge, cleared on
// open, surfaced via the Messages inbox — NOT the notifications feed. report_chat joins the hidden
// set per PR #21 (product decision): report chat is inbox-surfaced messaging like the others,
// superseding the earlier "reports are public civic objects, keep feed-visible" rationale.
export const FEED_HIDDEN_NOTIFICATION_TYPES: readonly NotificationType[] = [
  "dm",
  "cleanup_chat",
  "group_chat",
  "report_chat",
]

export function isFeedVisibleType(type: NotificationType): boolean {
  return !FEED_HIDDEN_NOTIFICATION_TYPES.includes(type)
}

export function parseTimeOfDayMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (!m) return null
  const hours = Number(m[1])
  const mins = Number(m[2])
  if (hours > 23 || mins > 59) return null
  return hours * 60 + mins
}

/**
 * Whether `now` falls inside the quiet window [start, end) — wrapping past midnight when start > end.
 * Either bound null (or unparseable), or start == end, means "no quiet hours" (never suppress).
 *
 * KNOWN LIMITATION — the window is evaluated in UTC, not the user's local time.
 *
 * quiet_start/quiet_end are pg `time` values: a time of day with NO zone. The client collects them from
 * a local-time picker, so "22:00–07:00" means 22:00 local to the person who set it, while the comparison
 * below is against now.getUTCHours(). For a Los Angeles user that suppresses push roughly 15:00–00:00
 * local instead of overnight — the feature is not merely inert, it is wrong in both directions.
 *
 * This is NOT fixable inside this function, because the server is never told the zone: notification_prefs
 * has no tz/utc-offset column (src/db/schema/notification_prefs.ts), the frozen @civfix/shared QuietHours
 * schema carries only { start, end }, and users.locale ("en"/"es"/"de"/"ko") does not imply a zone. Nor
 * can it be inferred from other data — a user's reports pin a place, not their own zone, and guessing
 * would silently mis-suppress notifications.
 *
 * Closing it requires a contract + migration change, one of:
 *   1. add `tz` (IANA name) to notification_prefs + QuietHours, and evaluate with Intl.DateTimeFormat in
 *      that zone — the only option that survives DST, and the recommended one; or
 *   2. define QuietHours as UTC on the wire and convert client-side — no migration, but it silently
 *      breaks twice a year for every DST zone and re-interprets rows already stored as local time.
 * Until then this stays UTC-anchored (deterministic regardless of the pod's TZ env) rather than pretending
 * to a precision it does not have. Failing OPEN (delivering) is the deliberate default: a suppressed bell
 * is data the user never learns existed.
 */
export function isWithinQuietHours(
  now: Date,
  start: string | null,
  end: string | null,
): boolean {
  if (start === null || end === null) return false
  const s = parseTimeOfDayMinutes(start)
  const e = parseTimeOfDayMinutes(end)
  if (s === null || e === null) return false
  if (s === e) return false
  const t = now.getUTCHours() * 60 + now.getUTCMinutes()
  if (s < e) return t >= s && t < e
  return t >= s || t < e
}

export function typeAllowedByPrefs(type: NotificationType, prefs: NotificationPrefsRecord): boolean {
  if (!prefs.push) return false
  switch (type) {
    case "report_update":
    case "claim_available":
    case "report_chat":
      return prefs.reportUpdates
    // cleanup_role (promoted/demoted/removed, WS4) rides the same "cleanups" pref bucket as the other
    // cleanup lifecycle bells — there is no dedicated pref field for it. So do the two P4 additions:
    // cleanup_slot (the role you claimed on an event was removed) and hours_logged (a host credited you
    // service hours) are event-lifecycle bells and ride the cleanups bucket until a dedicated toggle
    // exists. NotificationPrefsDTO is unchanged by P4, which is why no new pref field is read here.
    case "cleanup_chat":
    case "cleanup_reminder":
    case "cleanup_cancelled":
    case "cleanup_role":
    case "cleanup_slot":
    case "hours_logged":
    case "group_chat":
      // group_chat (P4 4.5, plan D8) rides the chat-message pref until a dedicated toggle exists.
      return prefs.cleanupChat
    case "new_follower":
      return prefs.follows
    // post_mention rides the same `mentions` toggle as chat/DM @mentions.
    case "post_mention":
      return prefs.mentions
    // Post interactions on YOUR post (someone liked / reposted / replied / quoted it).
    case "post_like":
    case "post_repost":
    case "post_reply":
    case "post_quote":
      return prefs.postInteractions
    case "system":
      return true
    default:
      return true
  }
}

export function toPrefsDTO(row: NotificationPrefsRecord): NotificationPrefsDTO {
  const hasQuiet = row.quietStart !== null && row.quietEnd !== null
  return {
    push: row.push,
    cleanupChat: row.cleanupChat,
    reportUpdates: row.reportUpdates,
    follows: row.follows,
    mentions: row.mentions,
    postInteractions: row.postInteractions,
    ...(hasQuiet ? { quietHours: { start: row.quietStart!, end: row.quietEnd! } } : {}),
  }
}

export function toNotificationDTO(record: NotificationRecord): NotificationDTO {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    ...(record.body !== null ? { body: record.body } : {}),
    read: record.readAt !== null,
    createdAt: record.createdAt.toISOString(),
    ...(record.link !== null ? { link: record.link } : {}),
  }
}
