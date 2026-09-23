import { ADMIN_REPORT_STATUS_LABELS, ReportTimelineItemSchema } from "@civfix/shared"
import type { AdminReportStatus, ReportTimelineItem } from "@civfix/shared"

/**
 * The design has three live buckets for the seven civfix statuses. An authed pin is created `published`
 * (live, visible, awaiting city action), so published and held belong in Submitted, not Completed.
 *
 * Single source of truth for the list-filter status set and the repo's countByBucket predicates. The admin
 * frontend keeps a matching map (src/lib/report-status.ts) so the pill labels and the filter never
 * disagree.
 *
 * There is deliberately no `removed` entry: removal soft-deletes the report, so `rejected` rows are
 * filtered out of every list and count by `deleted_at IS NULL` and the bucket would never be selectable.
 */
export const STATUS_BUCKETS: Record<
  "submitted" | "in_progress" | "completed",
  AdminReportStatus[]
> = {
  submitted: ["submitted", "held", "published"],
  in_progress: ["acknowledged", "in_progress"],
  completed: ["resolved"],
}

export interface ReportListFilter {
  statuses: AdminReportStatus[] | null
  flaggedOnly: boolean
  needsVerificationOnly: boolean
}

function listFilter(
  statuses: AdminReportStatus[] | null,
  flags: { flaggedOnly?: boolean; needsVerificationOnly?: boolean } = {},
): ReportListFilter {
  return {
    statuses,
    flaggedOnly: flags.flaggedOnly ?? false,
    needsVerificationOnly: flags.needsVerificationOnly ?? false,
  }
}

export function resolveListFilter(filter: string | undefined): ReportListFilter {
  switch (filter) {
    case "submitted":
      return listFilter(STATUS_BUCKETS.submitted)
    case "in_progress":
      return listFilter(STATUS_BUCKETS.in_progress)
    case "completed":
      return listFilter(STATUS_BUCKETS.completed)
    case "flagged":
      return listFilter(null, { flaggedOnly: true })
    case "needs_verification":
      return listFilter(STATUS_BUCKETS.submitted, { needsVerificationOnly: true })
    default:
      return listFilter(null)
  }
}

export function statusChangeNote(status: AdminReportStatus): string {
  if (status === "rejected") return "Report removed"
  return `Status set to ${ADMIN_REPORT_STATUS_LABELS[status]}`
}

/**
 * The admin timeline mapper matches on this note when a jurisdiction-reply row has no recorded `kind`: a
 * pre-0031 row, or one from a writer that leaves the column NULL, cannot be identified as a reply from its
 * status alone. It lives in this leaf module so the writer (inbound-thread-correlation) and the reader
 * share one constant without importing each other.
 */
export const JURISDICTION_REPLY_NOTE = "The city responded to this report"

const TIMELINE_KINDS: ReadonlySet<string> = new Set(ReportTimelineItemSchema.shape.kind.options)

// Keeps an unexpected column value (the column is plain text) from escaping into a strict response.
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
