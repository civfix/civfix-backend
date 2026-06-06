/**
 * Shared pure formatting helpers for the admin reports / events / users projections (Phase 2).
 *
 * Owned by the reports/events/users wave; imported by the three services so the relative+absolute
 * timestamp pair and the derived trust label render identically across every admin surface. Pure (no
 * IO, clock injected) so the projections stay unit-testable with no database. No sibling domain touches
 * this file.
 */

import { relativeAgo, type TrustLabel } from "@civfix/shared"
import type { RelAbsTime } from "@civfix/shared"

/**
 * The two canonical derived trust labels (decisions 3.3 / enumeration 4.5). DERIVED at read time from a
 * user's verification posture; never stored. A claimed account with a verified email OR any oauth
 * identity is a "verified neighbor"; an anon / unverified token is "Unverified".
 */
export const TRUST_VERIFIED: TrustLabel = "Verified neighbor"
export const TRUST_UNVERIFIED: TrustLabel = "Unverified"

/**
 * Derive the trust label from the verification signals. `emailVerified` is users.email_verified; `hasOauth`
 * is whether any oauth_identities row links the account. Either makes a verified neighbor.
 */
export function deriveTrust(input: { emailVerified: boolean; hasOauth: boolean }): TrustLabel {
  return input.emailVerified || input.hasOauth ? TRUST_VERIFIED : TRUST_UNVERIFIED
}

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
