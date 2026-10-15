import { ADMIN_CATEGORIES } from "./category-counts.js"
import type {
  AnalyticsByCategoryResponse,
  AnalyticsCoverageResponse,
  AnalyticsEventsResponse,
  AnalyticsFunnelResponse,
  AnalyticsHeatmapResponse,
  AnalyticsKpisResponse,
  AnalyticsPinsByWeekResponse,
  AnalyticsResolutionByCategoryResponse,
  AnalyticsRetentionResponse,
  AnalyticsTopContributorsResponse,
  AnalyticsTopJurisdictionsResponse,
  ReportCategory,
} from "@civfix/shared"
import type { AnalyticsRepository } from "./analytics-repository.js"

// The dashboard's fixed bar series, so a category with no reports still renders a 0 bar. Derived from
// ADMIN_CATEGORIES (from the contract enum): a hand-listed copy drifted from REPORT_CATEGORY_VALUES, and a
// category missing here is silently missing from every category chart.
export const ANALYTICS_CATEGORIES: readonly ReportCategory[] = ADMIN_CATEGORIES

export const PINS_BY_WEEK_WEEKS = 8
export const EVENTS_BY_MONTH_MONTHS = 8
export const RETENTION_COHORTS = 6

/** Default row cap for the table-style analytics (top jurisdictions / contributors). */
export const ANALYTICS_TABLE_LIMIT = 10
/** Heatmap cell cap (a denser list than the small tables). */
export const ANALYTICS_HEATMAP_LIMIT = 100

export interface AnalyticsServiceDeps {
  repo: AnalyticsRepository
  /** Injectable clock (defaults to Date.now) so the week/month windows are deterministic. */
  now?: () => Date
}

export interface AnalyticsService {
  kpis(): Promise<AnalyticsKpisResponse>
  pinsByWeek(): Promise<AnalyticsPinsByWeekResponse>
  byCategory(): Promise<AnalyticsByCategoryResponse>
  funnel(): Promise<AnalyticsFunnelResponse>
  coverage(): Promise<AnalyticsCoverageResponse>
  resolutionByCategory(): Promise<AnalyticsResolutionByCategoryResponse>
  events(): Promise<AnalyticsEventsResponse>
  topJurisdictions(): Promise<AnalyticsTopJurisdictionsResponse>
  topContributors(): Promise<AnalyticsTopContributorsResponse>
  heatmap(): Promise<AnalyticsHeatmapResponse>
  retention(): Promise<AnalyticsRetentionResponse>
}
