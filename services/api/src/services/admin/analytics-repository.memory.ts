/**
 * Aggregation is the database's job, so reproducing it in JS would re-implement the SQL. Instead a test
 * sets the canned aggregate each method returns and exercises the service's shaping against known inputs;
 * the integration test covers the real SQL aggregates.
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
} from "./analytics-repository.js"

/** All zero, so a test only sets what it asserts. */
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
