import type { AdminReportStatus, ReportTimelineItem } from "@civfix/shared"

/**
 * The canonical civfix-status -> design-bucket reconciliation (decisions 8 / enumeration 4.2). The design
 * surface has only three live buckets (Submitted | In progress | Completed) plus the orthogonal Removed,
 * but the civfix lifecycle has seven statuses: submitted -> held -> published -> acknowledged ->
 * in_progress -> resolved (+ rejected). An authed pin is created `published` (live, visible, AWAITING city
 * action), so published+held belong in the SUBMITTED bucket, NOT Completed. Only `resolved` is Completed.
 *
 * Single source of truth for the list-filter status SET AND the repo's countByBucket FILTER predicates
 * (admin-report-repository imports it). The admin frontend keeps a matching map (src/lib/report-status.ts)
 * so the pill labels and the filter never disagree.
 */
export const STATUS_BUCKETS: Record<
  "submitted" | "in_progress" | "completed" | "removed",
  AdminReportStatus[]
> = {
  submitted: ["submitted", "held", "published"],
  in_progress: ["acknowledged", "in_progress"],
  completed: ["resolved"],
  removed: ["rejected"],
}

/**
 * Map the list `filter` facet to a repo query shape. The design facet (all|submitted|in_progress|
 * completed|flagged) reconciles to a SET of civfix statuses to match (via STATUS_BUCKETS) and/or the
 * flagged-only marker. `all` matches everything.
 */
export function resolveListFilter(filter: string | undefined): {
  statuses: AdminReportStatus[] | null
  flaggedOnly: boolean
} {
  switch (filter) {
    case "submitted":
      return { statuses: STATUS_BUCKETS.submitted, flaggedOnly: false }
    case "in_progress":
      return { statuses: STATUS_BUCKETS.in_progress, flaggedOnly: false }
    case "completed":
      return { statuses: STATUS_BUCKETS.completed, flaggedOnly: false }
    case "flagged":
      return { statuses: null, flaggedOnly: true }
    default:
      return { statuses: null, flaggedOnly: false }
  }
}

export function statusChangeNote(status: AdminReportStatus): string {
  switch (status) {
    case "submitted":
      return "Status set to Submitted"
    case "in_progress":
      return "Status set to In progress"
    case "resolved":
      return "Status set to Resolved"
    case "rejected":
      return "Report removed"
    default:
      return `Status set to ${status}`
  }
}

/**
 * The note prefix a jurisdiction-reply timeline row carries (written by the inbound side-effects, §2.7).
 * The DTO maps a row with this prefix to the contract's `reply` timeline kind regardless of the row's
 * status, since report_timeline has no `kind` column. Keep in lockstep with the inbound processor's note.
 */
export const JURISDICTION_REPLY_NOTE_PREFIX = "Jurisdiction replied"

export function timelineKindForStatus(status: AdminReportStatus): ReportTimelineItem["kind"] {
  switch (status) {
    case "submitted":
      return "submit"
    case "acknowledged":
      return "route"
    case "resolved":
      return "done"
    case "rejected":
      return "remove"
    default:
      return "status"
  }
}
