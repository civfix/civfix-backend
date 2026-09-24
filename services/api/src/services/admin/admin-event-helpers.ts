// Pure helpers for the admin events domain. These hold NO DB/IO and are imported by BOTH the service and
// the repos — keeping them here (not in admin-event-service.ts) breaks the repo->service back-edge the
// memory repo would otherwise create by importing flaggedFromTimeline from the service.

import type { EventStatus, EventTimelineItem } from "@civfix/shared"

// The design facet (all|upcoming|in_progress|completed|flagged) reconciles to an event status to match
// and/or the flagged-only marker.
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

// flagged = the LAST flag/unflag entry in the ordered timeline is a 'flag'. The repo computes the same in
// SQL for the list; this is the in-memory mirror.
export function flaggedFromTimeline(kinds: readonly string[]): boolean {
  let flagged = false
  for (const kind of kinds) {
    if (kind === "flag") flagged = true
    else if (kind === "unflag") flagged = false
  }
  return flagged
}

// A fallback label for a note-less cleanup_timeline row, derived from its own kind. Used so a row with a
// null note never surfaces a blanket "Status set to Upcoming" (which would mislead on a join/done/flag).
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

// Map a stored cleanup_timeline kind to the design's event-timeline icon kind. The stored 'flag'/'unflag'
// map to 'warn'.
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
