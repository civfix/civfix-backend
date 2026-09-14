/**
 * Event status mapping: the one-way bridge from the DERIVED public CleanupStatus (0.46.0 — computed from
 * scheduled_at/ends_at by `cleanupStatusExpr`, never read from the stored column except for 'cancelled')
 * to the admin EventStatus wire enum.
 *
 * The map stays TOLERANT of every historical value so a legacy row, or a row an earlier admin build wrote
 * a Phase-2 value into, still resolves:
 *   active|in_progress      -> in_progress
 *   done|completed          -> completed
 *   cancelled               -> cancelled
 *   upcoming|anything else  -> upcoming
 *
 * There is no wire -> stored direction any more: status is a clock reading, and the only admin write is
 * Cancel (`adminEventStatusExpr` filters on the same derivation the reads project).
 */

import type { EventStatus } from "@civfix/shared"

export type StoredCleanupStatus = "upcoming" | "active" | "done" | "cancelled"

export function toEventStatus(stored: string): EventStatus {
  switch (stored) {
    case "active":
    case "in_progress":
      return "in_progress"
    case "done":
    case "completed":
      return "completed"
    case "cancelled":
      return "cancelled"
    default:
      return "upcoming"
  }
}
