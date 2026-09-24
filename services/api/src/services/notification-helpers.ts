import type { NotificationDTO, NotificationPrefsDTO, NotificationType } from "@civfix/shared"
import type { NotificationPrefsRecord, NotificationRecord } from "./notification-service.js"

export const DEFAULT_PREFS: NotificationPrefsRecord = {
  push: true,
  cleanupChat: true,
  reportUpdates: true,
  follows: true,
  mentions: true,
  postInteractions: true,
  hostBroadcasts: true,
  quietStart: null,
  quietEnd: null,
  tz: null,
}

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

function minutesInZone(now: Date, tz: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now)
    const hh = parts.find((p) => p.type === "hour")?.value
    const mm = parts.find((p) => p.type === "minute")?.value
    if (hh === undefined || mm === undefined) return null
    let h = Number(hh)
    if (h === 24) h = 0
    const m = Number(mm)
    if (!Number.isInteger(h) || !Number.isInteger(m)) return null
    return h * 60 + m
  } catch {
    return null
  }
}

export function isWithinQuietHours(
  now: Date,
  start: string | null,
  end: string | null,
  tz: string | null,
): boolean {
  if (tz === null) return false
  if (start === null || end === null) return false
  const s = parseTimeOfDayMinutes(start)
  const e = parseTimeOfDayMinutes(end)
  if (s === null || e === null) return false
  if (s === e) return false
  const t = minutesInZone(now, tz)
  if (t === null) return false
  if (s < e) return t >= s && t < e
  return t >= s || t < e
}

export function typeAllowedByPrefs(
  type: NotificationType,
  prefs: NotificationPrefsRecord,
): boolean {
  if (!prefs.push) return false
  switch (type) {
    case "report_update":
    case "claim_available":
    case "report_chat":
      return prefs.reportUpdates
    case "cleanup_chat":
    case "cleanup_reminder":
    case "cleanup_cancelled":
    case "cleanup_role":
    case "cleanup_slot":
    case "hours_logged":
    case "group_chat":
    case "event_team_invite":
      return prefs.cleanupChat
    case "new_follower":
      return prefs.follows
    case "post_mention":
      return prefs.mentions
    case "post_like":
    case "post_repost":
    case "post_reply":
    case "post_quote":
      return prefs.postInteractions
    case "event_broadcast":
      return prefs.hostBroadcasts
    case "system":
      return true
    default:
      return true
  }
}

export type PushGateMode = "auto" | "never" | "always"

export function pushGateAllows(
  type: NotificationType,
  prefs: NotificationPrefsRecord,
  mode: PushGateMode = "auto",
): boolean {
  if (mode === "never") return false
  if (!prefs.push) return false
  if (mode === "always") return true
  return typeAllowedByPrefs(type, prefs)
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
    hostBroadcasts: row.hostBroadcasts,
    ...(hasQuiet
      ? {
          quietHours: {
            start: row.quietStart!,
            end: row.quietEnd!,
            ...(row.tz !== null ? { tz: row.tz } : {}),
          },
        }
      : {}),
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
