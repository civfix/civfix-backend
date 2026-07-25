import { ReportTimelineItemSchema } from "@civfix/shared"
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
 *
 * There is deliberately NO `removed` entry: removal soft-deletes the report, so `rejected` rows are filtered
 * out of every list and count by `deleted_at IS NULL` — the bucket would never be selectable.
 */
export const STATUS_BUCKETS: Record<
  "submitted" | "in_progress" | "completed",
  AdminReportStatus[]
> = {
  submitted: ["submitted", "held", "published"],
  in_progress: ["acknowledged", "in_progress"],
  completed: ["resolved"],
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
 * A row with no recorded `kind` (report_timeline.kind, added by 0031) cannot be identified as a reply from
 * its status, and for those rows this prefix is the only signal. Reply rows are written through
 * appendSystemTimeline, which DOES pass kind — so live reply rows carry it and skip this sniff, which
 * remains the fallback for pre-0031 rows and for any writer that leaves the column NULL (most of them do;
 * see AdminReportTimelineRecord). Keep in lockstep with the inbound processor's note.
 */
export const JURISDICTION_REPLY_NOTE_PREFIX = "Jurisdiction replied"

/** The contract's timeline kinds, for narrowing a stored (plain-text) `report_timeline.kind` on read. */
const TIMELINE_KINDS: ReadonlySet<string> = new Set(ReportTimelineItemSchema.shape.kind.options)

/**
 * Narrow a stored `report_timeline.kind` to the contract union, or null when it is absent (a pre-0031 row,
 * or any of the writers that leave the column NULL) or not a value the DTO can carry. Keeps an unexpected
 * column value from escaping into a strict response.
 */
export function toTimelineKind(kind: string | null | undefined): ReportTimelineItem["kind"] | null {
  if (kind === null || kind === undefined) return null
  return TIMELINE_KINDS.has(kind) ? (kind as ReportTimelineItem["kind"]) : null
}

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
