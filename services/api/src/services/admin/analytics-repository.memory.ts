/**
 * In-memory AnalyticsRepository for the offline analytics-service unit tests (no DB, no Docker).
 *
 * Unlike the row-store memory repos elsewhere, analytics aggregation is the DATABASE's job (medians,
 * grouped counts, period windows), so reproducing it in JS would just re-implement the SQL. Instead this
 * repo lets a test SET the canned aggregate each method returns, so the test exercises the service's pure
 * SHAPING (pct, category fill, deltas, funnel, week/month/cohort alignment) against known inputs. The
 * Docker-gated integration test exercises the real SQL aggregates.
 */

import type {
  AnalyticsRepository,
  CategoryCount,
  CategoryMedian,
  CoverageCounts,
  EventAggregates,
  FunnelCounts,
  HeatmapCellRow,
  KpiAggregates,
  RetentionRow,
  TopContributorRow,
  TopJurisdictionRow,
  WeekBucket,
} from "./analytics-types.js"

/** Default empty KPI aggregates (all zero) so a test only sets what it asserts. */
function zeroKpis(): KpiAggregates {
  return {
    pins: { current: 0, previous: 0 },
    resolvedRatio: { current: 0, previous: 0 },
    cleanupsPlanned: { current: 0, previous: 0 },
    events: { current: 0, previous: 0 },
    newUsers: { current: 0, previous: 0 },
  }
}

export class InMemoryAnalyticsRepository implements AnalyticsRepository {
  kpisValue: KpiAggregates = zeroKpis()
  pinsByWeekValue: WeekBucket[] = []
  byCategoryValue: CategoryCount[] = []
  funnelValue: FunnelCounts = { dropped: 0, routed: 0, acknowledged: 0, resolved: 0 }
  coverageValue: CoverageCounts = { mapped: 0, needsMapping: 0 }
  resolutionByCategoryValue: CategoryMedian[] = []
  eventsValue: EventAggregates = { thisMonth: 0, volunteers: 0, bags: 0, byMonth: [] }
  topJurisdictionsValue: TopJurisdictionRow[] = []
  topContributorsValue: TopContributorRow[] = []
  heatmapValue: HeatmapCellRow[] = []
  retentionValue: RetentionRow[] = []

  // Getters return shallow copies so a test mutating a returned value can't corrupt the canned state.
  async kpis(): Promise<KpiAggregates> {
    return { ...this.kpisValue }
  }
  async pinsByWeek(_weeks: number): Promise<WeekBucket[]> {
    return [...this.pinsByWeekValue]
  }
  async byCategory(): Promise<CategoryCount[]> {
    return [...this.byCategoryValue]
  }
  async funnel(): Promise<FunnelCounts> {
    return { ...this.funnelValue }
  }
  async coverage(): Promise<CoverageCounts> {
    return { ...this.coverageValue }
  }
  async resolutionByCategory(): Promise<CategoryMedian[]> {
    return [...this.resolutionByCategoryValue]
  }
  async events(_months: number): Promise<EventAggregates> {
    return { ...this.eventsValue }
  }
  async topJurisdictions(_limit: number): Promise<TopJurisdictionRow[]> {
    return [...this.topJurisdictionsValue]
  }
  async topContributors(_limit: number): Promise<TopContributorRow[]> {
    return [...this.topContributorsValue]
  }
  async heatmap(_limit: number): Promise<HeatmapCellRow[]> {
    return [...this.heatmapValue]
  }
  async retention(_cohorts: number): Promise<RetentionRow[]> {
    return [...this.retentionValue]
  }
}
