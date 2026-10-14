const ISO_DAY_LENGTH = "YYYY-MM-DD".length

// en-CA formats a date as YYYY-MM-DD, the same shape as the UTC fallback.
const ISO_DAY_LOCALE = "en-CA"

function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, ISO_DAY_LENGTH)
}

export function eventDayKey(at: Date, timezone: string | null): string {
  if (timezone === null || timezone.length === 0) return utcDayKey(at)
  try {
    return new Intl.DateTimeFormat(ISO_DAY_LOCALE, {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at)
  } catch {
    // Intl throws RangeError on a zone name this runtime does not know; a UTC day beats no day.
    return utcDayKey(at)
  }
}
