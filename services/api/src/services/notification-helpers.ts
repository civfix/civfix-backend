
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
  quietStart: null,
  quietEnd: null,
}

export const FEED_HIDDEN_NOTIFICATION_TYPES: readonly NotificationType[] = ["dm", "cleanup_chat"]

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
      return prefs.reportUpdates
    case "cleanup_chat":
    case "cleanup_reminder":
    case "cleanup_cancelled":
      return prefs.cleanupChat
    case "new_follower":
      return prefs.follows
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
