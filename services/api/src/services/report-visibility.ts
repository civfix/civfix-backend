import type { ReportStatus } from "@civfix/shared"
import type { DiscussionReportView } from "./discussion-types.js"

/**
 * The statuses at which a report is PUBLICLY readable.
 *
 * The lifecycle is submitted -> held -> published -> acknowledged -> in_progress -> resolved (+ rejected;
 * see admin/admin-report-status.ts). A pin goes live at `published` and STAYS live while the city works
 * it: `acknowledged`, `in_progress` and `resolved` are progress states of an already-public report, not a
 * retraction of it. Only the PRE-publication states (`submitted`, `held` — the anon hold-then-publish
 * gate) and the moderator's `rejected` are hidden, plus the orthogonal owner `visibility = 'hidden'` and
 * the soft delete.
 *
 * H8-b: this used to be `status = 'published'` exactly, so ANY progression 404'd the report for everyone
 * but its owner and dropped it from the map/search pins — while the feeds' `fixes` filter selects posts
 * whose report is `resolved`, i.e. the product's headline "a fix happened" surface was structurally
 * unrenderable. Every consumer of this set (the SQL twin `publicReportFilter` in ./report-sql.ts,
 * `isReportVisibleTo` below, report-service.getReport, media-authorization's report lane, and the
 * owner-mutation 403-vs-404 decision in report-repository) MUST read it from here.
 */
export const PUBLIC_REPORT_STATUSES = [
  "published",
  "acknowledged",
  "in_progress",
  "resolved",
] as const satisfies readonly ReportStatus[]

/** Whether a raw `reports.status` value is one of PUBLIC_REPORT_STATUSES. */
export function isPubliclyVisibleStatus(status: string): boolean {
  return (PUBLIC_REPORT_STATUSES as readonly string[]).includes(status)
}

/**
 * The single source of truth for "may this viewer see this report".
 *
 * The SQL twin of the non-owner half of this predicate is `publicReportFilter()` in ./report-sql.ts
 * (`status IN PUBLIC_REPORT_STATUSES AND visibility = 'public' AND deleted_at IS NULL`). Any read path
 * that filters reports in the database MUST use that fragment rather than re-typing the conditions — H8
 * was exactly two hand-rolled copies of it in post-repository.drizzle.ts that had each dropped a
 * different term.
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
