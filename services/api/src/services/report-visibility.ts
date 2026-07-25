import type { DiscussionReportView } from "./discussion-types.js"

/**
 * The single source of truth for "may this viewer see this report".
 *
 * The SQL twin of the non-owner half of this predicate is `publicReportFilter()` in ./report-sql.ts
 * (`status = 'published' AND visibility = 'public' AND deleted_at IS NULL`). Any read path that filters
 * reports in the database MUST use that fragment rather than re-typing the conditions — H8 was exactly
 * two hand-rolled copies of it in post-repository.drizzle.ts that had each dropped a different term.
 */
export function isReportVisibleTo(
  report: DiscussionReportView | null,
  viewerUserId: string | null,
): boolean {
  if (report === null || report.deletedAt !== null) return false
  const mine = viewerUserId !== null && report.reporterUserId === viewerUserId
  const isPublic = report.status === "published" && report.visibility === "public"
  return isPublic || mine
}
