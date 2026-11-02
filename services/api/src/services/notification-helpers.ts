import { NotificationCategorySchema } from "@civfix/contract"
import type {
  NotificationCategory,
  NotificationDTO,
  NotificationPrefsDTO,
  NotificationType,
  UpdateNotificationPrefsRequest,
} from "@civfix/contract"
import type { NotificationPrefsRecord, NotificationRecord } from "./notification-repository.js"
import type { NotificationSettingsPatch } from "./notification-settings-repository.js"
import type { EffectiveNotificationSettings } from "./notification-settings-service.js"
import { MINUTES_PER_HOUR } from "../lib/time.js"

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

const TIME_OF_DAY_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/
const MAX_HOUR = 23
const MAX_MINUTE = 59

export function parseTimeOfDayMinutes(value: string): number | null {
  const m = TIME_OF_DAY_RE.exec(value.trim())
  if (!m) return null
  const hours = Number(m[1])
  const mins = Number(m[2])
  if (hours > MAX_HOUR || mins > MAX_MINUTE) return null
  return hours * MINUTES_PER_HOUR + mins
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
    // Some Intl implementations render midnight as hour 24 under hour12: false.
    if (h === 24) h = 0
    const m = Number(mm)
    if (!Number.isInteger(h) || !Number.isInteger(m)) return null
    return h * MINUTES_PER_HOUR + m
  } catch {
    // An unknown zone cannot place "now" in the user's day; failing open delivers the push rather
    // than silencing the user around the clock.
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

export type PushGateMode = "auto" | "never"

export function toPrefsDTO(row: NotificationPrefsRecord): NotificationPrefsDTO {
  const quietHours = quietHoursOf(row)
  return {
    push: row.push,
    cleanupChat: row.cleanupChat,
    reportUpdates: row.reportUpdates,
    follows: row.follows,
    mentions: row.mentions,
    postInteractions: row.postInteractions,
    hostBroadcasts: row.hostBroadcasts,
    ...(quietHours !== undefined ? { quietHours } : {}),
  }
}

function quietHoursOf(
  row: Pick<NotificationPrefsRecord, "quietStart" | "quietEnd" | "tz">,
): NotificationPrefsDTO["quietHours"] {
  if (row.quietStart === null || row.quietEnd === null) return undefined
  return {
    start: row.quietStart,
    end: row.quietEnd,
    ...(row.tz !== null ? { tz: row.tz } : {}),
  }
}

type LegacyPrefsSwitch = Exclude<keyof UpdateNotificationPrefsRequest, "push" | "quietHours">

// D4: the categories each old switch stands for, the same map the 0199 backfill applied.
const LEGACY_SWITCH_CATEGORIES: Readonly<
  Record<LegacyPrefsSwitch, readonly NotificationCategory[]>
> = {
  reportUpdates: ["reportUpdates", "reportDiscussions"],
  cleanupChat: ["groupChats", "events", "eventTeam"],
  mentions: ["mentions"],
  follows: ["followers"],
  postInteractions: ["likesAndReposts"],
  hostBroadcasts: ["hostAnnouncements"],
}

// The old mentions and host-broadcast switches hid the notifications entirely, so they also turn their
// category on or off.
const LEGACY_SWITCHES_SETTING_ENABLED: ReadonlySet<LegacyPrefsSwitch> = new Set([
  "mentions",
  "hostBroadcasts",
])

/** The old prefs DTO read from the new settings (D4), with quiet hours from notification_prefs. */
export function prefsFromSettings(
  settings: EffectiveNotificationSettings,
  quiet: NotificationPrefsRecord | null,
): NotificationPrefsDTO {
  const quietHours = quiet === null ? undefined : quietHoursOf(quiet)
  return {
    push: Object.values(settings).some((s) => s.push),
    cleanupChat: settings.groupChats.push,
    reportUpdates: settings.reportUpdates.push,
    follows: settings.followers.push,
    mentions: settings.mentions.enabled && settings.mentions.push,
    postInteractions: settings.likesAndReposts.push,
    hostBroadcasts: settings.hostAnnouncements.enabled,
    ...(quietHours !== undefined ? { quietHours } : {}),
  }
}

/** The settings an old prefs update writes (D4). Quiet hours are not settings and are left out. */
export function settingsPatchFromPrefs(
  patch: UpdateNotificationPrefsRequest,
): NotificationSettingsPatch {
  const out: NotificationSettingsPatch = {}
  for (const key of Object.keys(LEGACY_SWITCH_CATEGORIES) as LegacyPrefsSwitch[]) {
    const value = patch[key]
    if (value === undefined) continue
    for (const category of LEGACY_SWITCH_CATEGORIES[key]) {
      out[category] = LEGACY_SWITCHES_SETTING_ENABLED.has(key)
        ? { enabled: value, push: value }
        : { push: value }
    }
  }
  // Master off goes last so it wins over a switch turned on in the same body. Master on changes nothing
  // (D4): it never said which categories to check again.
  if (patch.push === false) {
    for (const category of NotificationCategorySchema.options) {
      out[category] = { ...out[category], push: false }
    }
  }
  return out
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
