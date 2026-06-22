/**
 * Per-H3-cell hourly submission cap (ANON-ONLY).
 *
 * A flood of pins on the same spot (one block, one intersection) is a classic anonymous-abuse pattern.
 * We bucket every anonymous submission by the H3 cell of its point and cap how many a single cell can
 * accept per hour. This is orthogonal to the per-IP cap: it throttles geographic concentration even
 * when the abuser rotates IPs.
 *
 * ANON-ONLY: authenticated users are exempt (accountable + publish immediately, per plan 11.7); only the
 * anon path calls `enforceH3CellCap`. The exemption is expressed by the call site and asserted by
 * `h3CellCapExempt`. This cap is ORTHOGONAL to the per-IP cap (it throttles geographic concentration
 * even when the abuser rotates IPs), and the abuse cell is UNRELATED to map clustering (that uses a
 * separate zoom-derived degree grid, not H3).
 */

import { latLngToCell } from "h3-js"
import { AppError } from "@civfix/shared"
import type { CounterStore } from "./counter-store.js"

/** H3 resolution for the per-cell ANON abuse cap (single number flips the whole policy). r10 ~130 m across, matches reports.h3_cell. */
export const ABUSE_H3_RES = 10

/** Max anonymous submissions a single H3 cell will accept per hour. */
export const H3_CELL_LIMIT_PER_HOUR = 30

/** Window length for the per-cell counter: one hour, in seconds. */
export const H3_WINDOW_SECONDS = 60 * 60

/** Redis key prefix for the per-cell hourly counter. */
const H3_COUNTER_PREFIX = "abuse:h3:"

/** Compute the H3 cell index for a point at the abuse resolution. PURE; wraps h3-js. */
export function abuseH3Cell(lat: number, lng: number): string {
  return latLngToCell(lat, lng, ABUSE_H3_RES)
}

/**
 * Whether this principal is EXEMPT from the per-cell cap. Authenticated callers (a resolved, non-null
 * userId) are exempt; anonymous callers (null/undefined userId) are not. Exposed so the rule is
 * testable and explicit even though only the anon path invokes the enforcement.
 */
export function h3CellCapExempt(auth: { userId: string | null | undefined }): boolean {
  return auth.userId !== null && auth.userId !== undefined
}

export interface H3CellCapDeps {
  counters: CounterStore
  /** Override the per-cell cap (tests). Defaults to H3_CELL_LIMIT_PER_HOUR. */
  limit?: number
}

/**
 * Enforce the per-cell hourly cap for an ANONYMOUS submission at (lat,lng). Increments the cell's
 * hour-window counter and throws AppError.rateLimited (429) when the count EXCEEDS the cap. The Nth
 * submission in a cell+window is allowed; the (cap+1)-th is rejected. Returns the cell + count for
 * logging. Callers MUST only invoke this for anonymous submissions (authed users are exempt).
 */
export async function enforceH3CellCap(
  lat: number,
  lng: number,
  deps: H3CellCapDeps,
): Promise<{ cell: string; count: number; limit: number }> {
  const cell = abuseH3Cell(lat, lng)
  const limit = deps.limit ?? H3_CELL_LIMIT_PER_HOUR
  const key = H3_COUNTER_PREFIX + cell
  const count = await deps.counters.incr(key, H3_WINDOW_SECONDS)
  if (count > limit) {
    throw AppError.rateLimited("Too many anonymous reports for this location right now. Try later.")
  }
  return { cell, count, limit }
}
