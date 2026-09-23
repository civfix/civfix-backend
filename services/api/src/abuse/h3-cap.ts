/**
 * Per-H3-cell hourly cap on ANONYMOUS submissions. A flood of pins on one spot is a classic anon-abuse
 * pattern, and bucketing by cell throttles geographic concentration even when the abuser rotates IPs, so
 * it is orthogonal to the per-IP cap. Authenticated users are exempt (accountable, and they publish
 * immediately): only the anon path calls `enforceH3CellCap`. The abuse cell is unrelated to map
 * clustering, which uses a zoom-derived degree grid.
 */

import { latLngToCell } from "h3-js"
import { AppError } from "@civfix/shared"
import type { CounterStore } from "./counter-store.js"

/** r10 is ~130 m across and matches reports.h3_cell. */
export const ABUSE_H3_RES = 10

export const H3_CELL_LIMIT_PER_HOUR = 30

export const H3_WINDOW_SECONDS = 60 * 60

const H3_COUNTER_PREFIX = "abuse:h3:"

export function abuseH3Cell(lat: number, lng: number): string {
  return latLngToCell(lat, lng, ABUSE_H3_RES)
}

/** Exported so the exemption rule is explicit and testable, even though only the anon path enforces the cap. */
export function h3CellCapExempt(auth: { userId: string | null | undefined }): boolean {
  return auth.userId !== null && auth.userId !== undefined
}

export interface H3CellCapDeps {
  counters: CounterStore
  /** Test override. */
  limit?: number
}

/**
 * The cap-th submission in a cell+window is allowed; the (cap+1)-th is rejected. Callers MUST invoke this
 * only for anonymous submissions.
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
