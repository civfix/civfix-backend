// Shared pure formatting helpers for the admin reports / events / users projections (clock injected, no
// IO) so the relative+absolute timestamp pair renders identically across every admin surface.

import { relativeAgo } from "@civfix/shared"
import type { RelAbsTime } from "@civfix/shared"

// Fixed to en-US + UTC so the absolute label is deterministic across machines + in tests (the design
// treats it as an unambiguous display string, not a locale-aware one).
const ABS_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

/** Format one Date into the design's absolute label, or "-" when null. */
export function absoluteLabel(date: Date | null): string {
  if (date === null) return "-"
  const t = date.getTime()
  if (Number.isNaN(t)) return "-"
  return ABS_FORMAT.format(date)
}

/**
 * Build the { rel, abs } timestamp pair the design renders. `rel` is the compact relative-ago label
 * (clock-injected via `now`); `abs` is the absolute label. A null date yields { rel: "-", abs: "-" }.
 */
export function toRelAbs(date: Date | null, now: Date): RelAbsTime {
  if (date === null) return { rel: "-", abs: "-" }
  return { rel: relativeAgo(date, now), abs: absoluteLabel(date) }
}
