import { relativeAgo } from "@civfix/shared"
import type { RelAbsTime } from "@civfix/shared"

// Fixed to en-US + UTC so the absolute label is deterministic across machines and in tests: the design
// treats it as an unambiguous display string, not a locale-aware one.
const ABS_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

// Module-private so no caller can render an `abs` without its paired `rel`.
function absoluteLabel(date: Date | null): string {
  if (date === null) return "-"
  const t = date.getTime()
  if (Number.isNaN(t)) return "-"
  return ABS_FORMAT.format(date)
}

export function toRelAbs(date: Date | null, now: Date): RelAbsTime {
  if (date === null) return { rel: "-", abs: "-" }
  return { rel: relativeAgo(date, now), abs: absoluteLabel(date) }
}
