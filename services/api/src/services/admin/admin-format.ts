/**
 * Shared pure formatting helpers for the admin reports / events / users projections (Phase 2).
 *
 * Owned by the reports/events/users wave; imported by the three services so the relative+absolute
 * timestamp pair and the derived trust label render identically across every admin surface. Pure (no
 * IO, clock injected) so the projections stay unit-testable with no database. No sibling domain touches
 * this file.
 */

import { relativeAgo } from "@civfix/shared"
import type { RelAbsTime } from "@civfix/shared"

/**
 * The absolute-timestamp formatter the design renders next to the relative one ("Jun 3, 2026, 4:12 PM").
 * Fixed to en-US + UTC so the label is deterministic across machines + in tests (the design treats it as
 * an unambiguous display string, not a locale-aware one). A null date renders an em-dash-free "-".
 */
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
