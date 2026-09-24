/**
 * Status is derived from scheduled_at/ends_at (the stored column is read only for 'cancelled'), so this
 * maps one way, to the admin wire enum. It accepts both the public (active/done) and admin
 * (in_progress/completed) vocabularies so a legacy row still resolves. There is no wire -> stored
 * direction: status is a clock reading, and the only admin write is Cancel.
 */

import type { EventStatus } from "@civfix/shared"

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
