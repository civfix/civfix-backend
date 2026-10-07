import type { ReportCategory } from "@civfix/shared"

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
