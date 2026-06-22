// Pure (no DB, no IO) helpers for the notifications domain: prefs defaults, the quiet-hours gate, the
// per-type push allow rule, and the DTO projections. Split out of notification-service.ts so the gating
// is unit-testable in isolation and the service file carries only the wiring.

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

// Parse "HH:MM"/"HH:MM:SS" into minutes-since-midnight (0..1439); null for a malformed value so the
// quiet-hours math can fail safe to "not quiet". Seconds are floored into the minute.
export function parseTimeOfDayMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (!m) return null
  const hours = Number(m[1])
  const mins = Number(m[2])
  if (hours > 23 || mins > 59) return null
  return hours * 60 + mins
}

// Whether `now` falls within the quiet window [start, end). The pg `time` columns are stored wall-clock
// with no tz; this evaluates them in a FIXED reference (UTC) via getUTCHours/getUTCMinutes, NOT the
// server process's local tz — a server-local read would suppress pushes at the wrong hours for any
// deployment not in UTC. Wrap-around-midnight aware; equal bounds = empty window (never quiet, so a
// misconfigured equal pair does not silently mute every push); malformed input fails open (not quiet).
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

// Whether the user's prefs permit a push for `type`: the master switch AND the per-type toggle.
// NOTE: the @-mention bell reuses report_update (discussion) / cleanup_chat (chat) types, so the
// dedicated `mentions` toggle CANNOT be enforced here (the type alone does not say "mention"); it is
// enforced where each mention notifier fires, via getPrefs + a !mentions short-circuit.
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
  // quietHours is present on the wire only when BOTH bounds are set (null-vs-undefined: an unset pair is
  // omitted, not sent as null).
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
