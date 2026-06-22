/**
 * Event status mapping (Phase 2): the SINGLE bidirectional bridge between the stored Phase-1
 * cleanups.status enum and the Phase-2 EventStatus wire enum.
 *
 * H1 background: cleanups.status is the Phase-1 enum (upcoming|active|done|cancelled, enforced by the
 * enums.test.ts drift guard against the shared CleanupStatusSchema). The Phase-2 admin events DTO uses
 * EventStatus = upcoming|in_progress|completed|cancelled. Storage stays on the Phase-1 enum (no migration:
 * the rest of the system + the drift test depend on it); EVERY admin read maps stored -> EventStatus and
 * EVERY admin write maps EventStatus -> stored, so a filter and a write never disagree and no invalid enum
 * value is written or leaked.
 *
 * The map is intentionally TOLERANT in BOTH directions so a legacy row OR a row written by an earlier
 * (pre-fix) admin build that leaked a Phase-2 value into cleanups.status still resolves correctly:
 *   stored  active|in_progress      -> in_progress
 *   stored  done|completed          -> completed
 *   stored  cancelled               -> cancelled
 *   stored  upcoming|anything else  -> upcoming
 *   wire    in_progress             -> active   (Phase-1 storage value)
 *   wire    completed               -> done     (Phase-1 storage value)
 *   wire    cancelled               -> cancelled
 *   wire    upcoming                -> upcoming
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

export function toStoredCleanupStatus(status: EventStatus): StoredCleanupStatus {
  switch (status) {
    case "in_progress":
      return "active"
    case "completed":
      return "done"
    case "cancelled":
      return "cancelled"
    case "upcoming":
      return "upcoming"
    default: {
      // EventStatus is exhausted above; this guards against a future enum widening at compile time.
      const _exhaustive: never = status
      void _exhaustive
      return "upcoming"
    }
  }
}

// The stored cleanups.status values that map to a given EventStatus, so a filter matches BOTH the Phase-1
// stored value AND any leaked Phase-2 value (so filter=completed catches stored 'done' AND a mis-stored
// 'completed'). Match with `c.status = ANY(...)`.
export function storedVariantsForEventStatus(status: EventStatus): string[] {
  switch (status) {
    case "in_progress":
      return ["active", "in_progress"]
    case "completed":
      return ["done", "completed"]
    case "cancelled":
      return ["cancelled"]
    case "upcoming":
      return ["upcoming"]
    default:
      return ["upcoming"]
  }
}
