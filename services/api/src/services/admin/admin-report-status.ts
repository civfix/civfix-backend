import { ADMIN_REPORT_STATUS_LABELS, ReportTimelineItemSchema } from "@civfix/shared"
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
 * completed|flagged|needs_verification) reconciles to a SET of civfix statuses to match (via
 * STATUS_BUCKETS) and/or the flagged-only / needs-verification-only markers. `all` matches everything.
 */
export function resolveListFilter(filter: string | undefined): {
  statuses: AdminReportStatus[] | null
  flaggedOnly: boolean
  needsVerificationOnly: boolean
} {
  switch (filter) {
    case "submitted":
      return {
        statuses: STATUS_BUCKETS.submitted,
        flaggedOnly: false,
        needsVerificationOnly: false,
      }
    case "in_progress":
      return {
        statuses: STATUS_BUCKETS.in_progress,
        flaggedOnly: false,
        needsVerificationOnly: false,
      }
    case "completed":
      return {
        statuses: STATUS_BUCKETS.completed,
        flaggedOnly: false,
        needsVerificationOnly: false,
      }
    case "flagged":
      return { statuses: null, flaggedOnly: true, needsVerificationOnly: false }
    case "needs_verification":
      return {
        statuses: STATUS_BUCKETS.submitted,
        flaggedOnly: false,
        needsVerificationOnly: true,
      }
    default:
      return { statuses: null, flaggedOnly: false, needsVerificationOnly: false }
  }
}

export function statusChangeNote(status: AdminReportStatus): string {
  if (status === "rejected") return "Report removed"
  return `Status set to ${ADMIN_REPORT_STATUS_LABELS[status]}`
}

/**
 * The note a jurisdiction-reply timeline row carries, written by the inbound side-effects (§2.7) and read
 * back by the admin timeline mapper when the row has no recorded `kind` (report_timeline.kind, added by
 * 0031) — a pre-0031 row, or one from a writer that leaves the column NULL, cannot be identified as a
 * reply from its status alone. It lives in this leaf module so the note is ONE constant shared by the
 * writer (inbound-thread-correlation) and the reader without either importing the other.
 */
export const JURISDICTION_REPLY_NOTE = "The city responded to this report"

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
