export function eventDayKey(at: Date, timezone: string | null): string {
  if (timezone === null || timezone.length === 0) return at.toISOString().slice(0, 10)
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at)
  } catch {
    // Intl throws RangeError on a zone name this runtime does not know; a UTC day beats no day.
    return at.toISOString().slice(0, 10)
  }
}
