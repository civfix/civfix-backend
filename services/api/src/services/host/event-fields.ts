import { AppError, MAX_EVENT_GALLERY_MEDIA, MAX_EVENT_REMINDER_OFFSETS } from "@civfix/shared"

export const DEFAULT_EVENT_TIME_ZONE = "America/Los_Angeles"

export const EVENT_REMINDER_OFFSET_CHOICES: readonly number[] = [60, 180, 1440, 2880, 10080]

const FALLBACK_TIMEZONES: readonly string[] = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Phoenix",
  "America/Chicago",
  "America/New_York",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
]

let timezoneSet: ReadonlySet<string> | null = null

function supportedTimezones(): ReadonlySet<string> {
  if (timezoneSet !== null) return timezoneSet
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf
  const values =
    typeof supported === "function" ? supported.call(Intl, "timeZone") : [...FALLBACK_TIMEZONES]
  timezoneSet = new Set(values.length > 0 ? values : FALLBACK_TIMEZONES)
  return timezoneSet
}

export function assertValidTimezone(timezone: string | null | undefined): void {
  if (timezone === null || timezone === undefined) return
  if (!supportedTimezones().has(timezone)) {
    throw AppError.validation({ timezone: "must be a valid IANA time zone" })
  }
}

export function assertValidReminderOffsets(offsets: readonly number[] | null | undefined): void {
  if (offsets === null || offsets === undefined) return
  if (offsets.length > MAX_EVENT_REMINDER_OFFSETS) {
    throw AppError.validation({
      reminderOffsetsMinutes: `at most ${MAX_EVENT_REMINDER_OFFSETS} reminders may be scheduled`,
    })
  }
  if (new Set(offsets).size !== offsets.length) {
    throw AppError.validation({ reminderOffsetsMinutes: "must not repeat an offset" })
  }
  for (const offset of offsets) {
    if (!EVENT_REMINDER_OFFSET_CHOICES.includes(offset)) {
      throw AppError.validation({
        reminderOffsetsMinutes: `must be one of ${EVENT_REMINDER_OFFSET_CHOICES.join(", ")} minutes`,
      })
    }
  }
}

export function assertGalleryWithinCap(mediaIds: readonly string[] | null | undefined): void {
  if (mediaIds === null || mediaIds === undefined) return
  if (mediaIds.length > MAX_EVENT_GALLERY_MEDIA) {
    throw AppError.validation({
      galleryMediaIds: `at most ${MAX_EVENT_GALLERY_MEDIA} images may be attached`,
    })
  }
  if (new Set(mediaIds).size !== mediaIds.length) {
    throw AppError.validation({ galleryMediaIds: "must not repeat an image" })
  }
}

export function assertEventWindow(input: {
  scheduledAt: Date
  endsAt: Date | null
  registrationOpensAt: Date | null
  registrationClosesAt: Date | null
}): void {
  if (input.endsAt !== null && input.endsAt.getTime() <= input.scheduledAt.getTime()) {
    throw AppError.validation({ endsAt: "must be after the start time" })
  }
  if (
    input.registrationOpensAt !== null &&
    input.registrationClosesAt !== null &&
    input.registrationClosesAt.getTime() <= input.registrationOpensAt.getTime()
  ) {
    throw AppError.validation({ registrationClosesAt: "must be after registration opens" })
  }
}
