/**
 * Admin analytics service (Phase 2): the 11 read-only aggregate endpoints (#56-#66). The repo returns RAW
 * aggregates (counts, grouped rows, SQL-computed medians); this service does the pure shaping (pct,
 * category fill, KPI deltas, funnel/coverage, week/month/cohort labels) the wire DTOs need. Shaping lives
 * in analytics-shaping.ts (unit-tested); aggregate shapes + the repo seam in analytics-types.ts.
 *
 * Reconciliation: by-category + resolution-by-category use the 6 real report categories (the design's
 * "cleanup" is the Events domain, not a report category). "Avg. route time" is a Phase 3 (VRP) metric,
 * reported as 0 until routing is deployed.
 */

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
} from "@civfix/shared"
import {
  ANALYTICS_HEATMAP_LIMIT,
  ANALYTICS_TABLE_LIMIT,
  EVENTS_BY_MONTH_MONTHS,
  PINS_BY_WEEK_WEEKS,
  RETENTION_COHORTS,
  type AnalyticsService,
  type AnalyticsServiceDeps,
} from "./analytics-types.js"
import {
  buildByCategory,
  buildCoverage,
  buildEvents,
  buildFunnel,
  buildKpis,
  buildPinsByWeek,
  buildResolutionByCategory,
  buildRetention,
  pct,
} from "./analytics-shaping.js"

export * from "./analytics-types.js"
export * from "./analytics-shaping.js"

export function makeAnalyticsService(deps: AnalyticsServiceDeps): AnalyticsService {
  const now = deps.now ?? (() => new Date())
  return {
    async kpis(): Promise<AnalyticsKpisResponse> {
      return { kpis: buildKpis(await deps.repo.kpis()) }
    },
    async pinsByWeek(): Promise<AnalyticsPinsByWeekResponse> {
      const buckets = await deps.repo.pinsByWeek(PINS_BY_WEEK_WEEKS)
      return buildPinsByWeek(buckets, PINS_BY_WEEK_WEEKS, now())
    },
    async byCategory(): Promise<AnalyticsByCategoryResponse> {
      return { rows: buildByCategory(await deps.repo.byCategory()) }
    },
    async funnel(): Promise<AnalyticsFunnelResponse> {
      return buildFunnel(await deps.repo.funnel())
    },
    async coverage(): Promise<AnalyticsCoverageResponse> {
      return buildCoverage(await deps.repo.coverage())
    },
    async resolutionByCategory(): Promise<AnalyticsResolutionByCategoryResponse> {
      return buildResolutionByCategory(await deps.repo.resolutionByCategory())
    },
    async events(): Promise<AnalyticsEventsResponse> {
      const agg = await deps.repo.events(EVENTS_BY_MONTH_MONTHS)
      return buildEvents(agg, EVENTS_BY_MONTH_MONTHS, now())
    },
    async topJurisdictions(): Promise<AnalyticsTopJurisdictionsResponse> {
      const rows = await deps.repo.topJurisdictions(ANALYTICS_TABLE_LIMIT)
      // `resolved` is emitted as a 0-100 resolution percentage (resolved / pins), not a raw count.
      return {
        rows: rows.map((r) => ({ org: r.org, pins: r.pins, resolved: pct(r.resolved, r.pins) })),
      }
    },
    async topContributors(): Promise<AnalyticsTopContributorsResponse> {
      const rows = await deps.repo.topContributors(ANALYTICS_TABLE_LIMIT)
      return {
        rows: rows.map((r) => ({
          name: r.name,
          city: r.city,
          reports: r.reports,
          cleanups: r.cleanups,
        })),
      }
    },
    async heatmap(): Promise<AnalyticsHeatmapResponse> {
      const cells = await deps.repo.heatmap(ANALYTICS_HEATMAP_LIMIT)
      return {
        cells: cells.map((c) => ({
          geoid: c.geoid,
          name: c.name,
          density: c.density,
          lat: c.lat,
          lng: c.lng,
        })),
      }
    },
    async retention(): Promise<AnalyticsRetentionResponse> {
      const rows = await deps.repo.retention(RETENTION_COHORTS)
      return buildRetention(rows, RETENTION_COHORTS)
    },
  }
}
