// All that survives of the retired per-report discussion domain (report chat replaced it). The
// "Discussion" names are kept for continuity with their call sites.

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

// An interface so the report-chat visibility and @city-forward code can run against a fake.
export interface DiscussionRepository {
  findReportForDiscussion(reportId: string): Promise<DiscussionReportView | null>
}
