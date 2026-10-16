import { OPEN_REPORT_STATUSES, PUBLIC_REPORT_STATUSES } from "@civfix/contract"
import type { ReportVisibility } from "@civfix/contract"
import type { DiscussionReportView } from "./discussion-repository.js"
import type { OwnerToggleStatus } from "./report-repository.js"

/**
 * The statuses at which a report is PUBLICLY readable come from the contract's PUBLIC_REPORT_STATUSES.
 *
 * The lifecycle is submitted -> held -> published -> acknowledged -> in_progress -> resolved (+ rejected;
 * see admin/admin-report-status.ts). A pin goes live at `published` and STAYS live while the city works
 * it: `acknowledged`, `in_progress` and `resolved` are progress states of an already-public report, not a
 * retraction of it. Only the PRE-publication states (`submitted`, and `held`, the anon hold-then-publish
 * gate) and the moderator's `rejected` are hidden, plus the orthogonal owner `visibility = 'hidden'` and
 * the soft delete.
 *
 * This used to be `status = 'published'` exactly, so ANY progression 404'd the report for everyone but
 * its owner and dropped it from the map/search pins, while the feeds' `fixes` filter selects posts
 * whose report is `resolved`, i.e. the product's headline "a fix happened" surface was structurally
 * unrenderable. Every consumer of this set (the SQL twin `publicReportFilter` in ./report-sql.ts,
 * `isReportVisibleTo` below, report-service.getReport, media-authorization's report lane, and the
 * owner-mutation 403-vs-404 decision in report-repository) MUST read it from the contract, never a copy.
 */
export function isPubliclyVisibleStatus(status: string): boolean {
  return (PUBLIC_REPORT_STATUSES as readonly string[]).includes(status)
}

export type OwnerStatusTransition = "apply" | "unchanged" | "invalid_state"

// The owner may only toggle resolved <-> open. Reopening a report that is not resolved is a no-op so it can
// never regress the city's acknowledged / in_progress progress back to published, and repeating the current
// state writes no timeline row and announces nothing.
export function ownerStatusTransition(
  current: string,
  target: OwnerToggleStatus,
): OwnerStatusTransition {
  if (!isPubliclyVisibleStatus(current)) return "invalid_state"
  const isResolved = current === "resolved"
  return isResolved === (target === "resolved") ? "unchanged" : "apply"
}

/**
 * The single source of truth for "may this viewer see this report".
 *
 * The SQL twin of the non-owner half of this predicate is `publicReportFilter()` in ./report-sql.ts
 * (`status IN PUBLIC_REPORT_STATUSES AND visibility = 'public' AND deleted_at IS NULL`). Any read path
 * that filters reports in the database MUST use that fragment rather than re-typing the conditions: two
 * hand-rolled copies of it in post-repository.drizzle.ts once each dropped a different term.
 */
export function isReportVisibleTo(
  report: DiscussionReportView | null,
  viewerUserId: string | null,
): boolean {
  if (report === null || report.deletedAt !== null) return false
  const mine = viewerUserId !== null && report.reporterUserId === viewerUserId
  const isPublic = isPubliclyVisibleStatus(report.status) && report.visibility === "public"
  return isPublic || mine
}

export interface ConfirmationTarget {
  reporterUserId: string | null
  status: string
  visibility: ReportVisibility
  deletedAt: Date | null
}

export type ConfirmationVerdict = "allowed" | "not_found" | "forbidden" | "closed"

/**
 * Whether `userId` may add ("confirm") or remove ("unconfirm") a Me too on this report, in the contract's
 * error order. Visibility is judged as a non-owner sees it, so a report its own reporter can still open
 * (hidden, held, submitted, rejected) is `not_found` for them too, and never reveals that it exists.
 * Removal works on any visible report, so a confirmation made before the report was resolved can still
 * be taken back.
 */
export function confirmationVerdict(
  report: ConfirmationTarget,
  userId: string,
  action: "confirm" | "unconfirm",
): ConfirmationVerdict {
  if (report.deletedAt !== null) return "not_found"
  if (!isPubliclyVisibleStatus(report.status) || report.visibility !== "public") return "not_found"
  if (report.reporterUserId === userId) return "forbidden"
  if (
    action === "confirm" &&
    !(OPEN_REPORT_STATUSES as readonly string[]).includes(report.status)
  ) {
    return "closed"
  }
  return "allowed"
}
