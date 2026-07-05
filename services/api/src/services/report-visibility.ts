import type { DiscussionReportView } from "./discussion-types.js"

export function isReportVisibleTo(
  report: DiscussionReportView | null,
  viewerUserId: string | null,
): boolean {
  if (report === null || report.deletedAt !== null) return false
  const mine = viewerUserId !== null && report.reporterUserId === viewerUserId
  const isPublic = report.status === "published" && report.visibility === "public"
  return isPublic || mine
}
