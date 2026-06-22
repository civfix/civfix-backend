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

// The 6 canonical report categories in canonical order. Kept backend-local rather than imported from
// @civfix/shared: analytics owns its own axis ordering (the dashboard renders a fixed 7-bar series and a
// category with no reports must still render a 0 bar). Mirrors REPORT_CATEGORY_VALUES.
export const ANALYTICS_CATEGORIES: readonly ReportCategory[] = [
  "trash",
  "recycling",
  "graffiti",
  "hazard",
  "encampment",
  "water",
  "other",
] as const

export const PINS_BY_WEEK_WEEKS = 8
export const EVENTS_BY_MONTH_MONTHS = 8
export const RETENTION_COHORTS = 6

/** Two-period counter (this period vs the prior period) used to compute a KPI delta. */
export interface PeriodCount {
  current: number
  previous: number
}

export interface KpiAggregates {
  pins: PeriodCount
  resolvedRatio: { current: number; previous: number }
  cleanupsPlanned: PeriodCount
  events: PeriodCount
  newUsers: PeriodCount
}

export interface WeekBucket {
  weekStart: Date
  count: number
}

export interface MonthBucket {
  year: number
  month: number
  count: number
}

export interface CategoryCount {
  category: ReportCategory
  count: number
}

export interface CategoryMedian {
  category: ReportCategory
  medianHours: number
}

export interface FunnelCounts {
  dropped: number
  routed: number
  acknowledged: number
  resolved: number
}

export interface CoverageCounts {
  mapped: number
  needsMapping: number
}

export interface EventAggregates {
  thisMonth: number
  volunteers: number
  bags: number
  byMonth: MonthBucket[]
}

export interface TopJurisdictionRow {
  org: string
  pins: number
  resolved: number
}

export interface TopContributorRow {
  name: string
  city: string
  reports: number
  cleanups: number
}

export interface HeatmapCellRow {
  geoid: string
  name: string
  density: number
  lat: number
  lng: number
}

/**
 * One cohort (signup year/month) with its size and, per trailing period index, the number of cohort
 * members active in that period (period 0 = the signup month). The service converts the active counts to
 * retention ratios.
 */
export interface RetentionRow {
  year: number
  month: number
  size: number
  /** activeByPeriod[i] = members active in period i (0-based; 0 is the signup month). */
  activeByPeriod: number[]
}

/**
 * Persistence seam for analytics. The Drizzle impl runs the raw SQL aggregates; the offline tests pass an
 * in-memory impl that returns canned aggregates so the SHAPING is unit-tested without a database.
 */
export interface AnalyticsRepository {
  kpis(): Promise<KpiAggregates>
  pinsByWeek(weeks: number): Promise<WeekBucket[]>
  byCategory(): Promise<CategoryCount[]>
  funnel(): Promise<FunnelCounts>
  coverage(): Promise<CoverageCounts>
  resolutionByCategory(): Promise<CategoryMedian[]>
  events(months: number): Promise<EventAggregates>
  topJurisdictions(limit: number): Promise<TopJurisdictionRow[]>
  topContributors(limit: number): Promise<TopContributorRow[]>
  heatmap(limit: number): Promise<HeatmapCellRow[]>
  retention(cohorts: number): Promise<RetentionRow[]>
}

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
