// Kept out of admin-event-service.ts so the repos can import these without a repo->service back-edge.

import type { EventStatus, EventTimelineItem } from "@civfix/shared"

export function resolveEventFilter(filter: string | undefined): {
  status: EventStatus | null
  flaggedOnly: boolean
} {
  switch (filter) {
    case "upcoming":
      return { status: "upcoming", flaggedOnly: false }
    case "in_progress":
      return { status: "in_progress", flaggedOnly: false }
    case "completed":
      return { status: "completed", flaggedOnly: false }
    case "flagged":
      return { status: null, flaggedOnly: true }
    default:
      return { status: null, flaggedOnly: false }
  }
}

export function eventStatusNote(status: EventStatus): string {
  switch (status) {
    case "upcoming":
      return "Status set to Upcoming"
    case "in_progress":
      return "Status set to In progress"
    case "completed":
      return "Status set to Completed"
    case "cancelled":
      return "Event cancelled"
    default:
      return `Status set to ${status}`
  }
}

// The in-memory twin of flaggedEventExpr (admin-event-sql.ts); the two must agree.
export function flaggedFromTimeline(kinds: readonly string[]): boolean {
  let flagged = false
  for (const kind of kinds) {
    if (kind === "flag") flagged = true
    else if (kind === "unflag") flagged = false
  }
  return flagged
}

// A note-less timeline row is labelled from its own kind so it never surfaces a blanket "Status set to
// Upcoming", which would mislead on a join/done/flag row.
export function timelineDefaultNote(kind: string): string {
  switch (kind) {
    case "create":
      return "Event created"
    case "join":
      return "Joined the cleanup"
    case "message":
      return "Posted an update"
    case "done":
      return "Marked done"
    case "cancel":
      return "Event cancelled"
    case "flag":
      return "Flagged for review"
    case "unflag":
      return "Flag cleared"
    case "report_linked":
      return "Linked a report"
    case "report_unlinked":
      return "Unlinked a report"
    default:
      return "Status updated"
  }
}

/** The event detail shows at most this many chat messages: the most recent ones. */
export const ADMIN_EVENT_MESSAGE_CAP = 100

export function eventOutcomeNote(bags: number): string {
  return bags === 1 ? "Outcome logged: 1 bag" : `Outcome logged: ${bags} bags`
}

export function eventTimelineKind(stored: string): EventTimelineItem["kind"] {
  switch (stored) {
    case "create":
    case "status":
    case "join":
    case "message":
    case "done":
    case "cancel":
      return stored
    case "flag":
    case "unflag":
    case "warn":
      return "warn"
    case "report_linked":
      return "linked"
    case "report_unlinked":
      return "unlinked"
    default:
      return "status"
  }
}
