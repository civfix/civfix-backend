/**
 * Report-jurisdiction lookup types shared by the report-chat @city-forward path.
 *
 * These are all that survive of the former per-report DISCUSSION domain (the discussion comment tables,
 * service, and message DTOs were removed with the discussion system — report chat replaced it). What
 * report chat still needs is a single read: "given a report id, what is its visibility + resolved
 * jurisdiction + first usable contact email?" — used to gate report-chat room visibility and to decide
 * whether an @city mention in a chat message should be forwarded. That read is `findReportForDiscussion`
 * on the minimal `DiscussionRepository` below (name kept for continuity with its call sites).
 */

export interface ReportJurisdictionView {
  geoid: string
  name: string
  handle: string | null
  // First usable contact email (per-category -> default -> legacy), or null when none.
  contactEmail: string | null
}

export interface DiscussionReportView {
  id: string
  reporterUserId: string | null
  status: string
  visibility: string
  deletedAt: Date | null
  jurisdiction: ReportJurisdictionView | null
  category: string
  place: string | null
}

// Persistence seam for the single report-lookup the report-chat surface needs. The Drizzle impl runs raw
// SQL; keeping it behind an interface makes the report-chat visibility + @city-forward code fakeable.
export interface DiscussionRepository {
  findReportForDiscussion(reportId: string): Promise<DiscussionReportView | null>
}
