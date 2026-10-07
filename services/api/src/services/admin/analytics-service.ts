/**
 * The repo returns raw aggregates; the shaping the wire DTOs need lives in analytics-shaping.ts.
 *
 * The by-category charts use the report categories only: the design's "cleanup" belongs to the Events
 * domain, not to the report categories. "Avg. route time" is reported as 0 until routing is deployed.
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
