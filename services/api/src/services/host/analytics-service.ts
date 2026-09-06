import {
  ANALYTICS_SUPPRESSION_K,
  type AnalyticsRange,
  type BreakdownRow,
  type EventAnalyticsBroadcastsResponse,
  type EventAnalyticsCheckinsResponse,
  type EventAnalyticsOverviewResponse,
  type EventAnalyticsRegistrationsResponse,
  type EventAnalyticsSourcesResponse,
  type FunnelStep,
  type HostedEventsAnalyticsResponse,
  type Panel,
  type PortfolioAnalyticsRange,
  type SeriesPoint,
  type SuppressedRate,
} from "@civfix/shared"
import {
  arrivalsCurve,
  bestDayTime,
  breakdown,
  dailySeries,
  funnel,
  repeatAttendanceRate,
  seriesClosure,
  suppressCount,
  suppressRate,
  type DayCount,
  type DerivedBreakdownRow,
  type DerivedPanel,
  type KeyCount,
  type SeriesClosure,
} from "@civfix/shared/host"
import type { AnalyticsRepository } from "./analytics-repository.drizzle.js"
import type { MetricRow, MetricsRepository } from "./metrics-repository.drizzle.js"
import { hostAnalyticsCacheKey, type HostAnalyticsCache } from "./host-analytics-cache.js"

export const PORTFOLIO_EVENT_LIMIT = 200
export const ARRIVAL_SAMPLE_LIMIT = 20_000

const RANGE_DAYS: Record<AnalyticsRange, number | null> = { "7d": 7, "30d": 30, "90d": 90, all: null }
const PORTFOLIO_RANGE_DAYS: Record<PortfolioAnalyticsRange, number | null> = {
  "30d": 30,
  "90d": 90,
  "365d": 365,
  all: null,
}

const ALL_RANGE_DAYS = 365

export interface AnalyticsServiceDeps {
  analytics: AnalyticsRepository
  metrics: MetricsRepository
  cache: HostAnalyticsCache
  now?: () => Date
}

export interface AnalyticsService {
  overview(cleanupId: string, range: AnalyticsRange, viewerScope: string): Promise<EventAnalyticsOverviewResponse>
  registrations(
    cleanupId: string,
    range: AnalyticsRange,
    viewerScope: string,
  ): Promise<EventAnalyticsRegistrationsResponse>
  checkins(
    cleanupId: string,
    range: AnalyticsRange,
    viewerScope: string,
  ): Promise<EventAnalyticsCheckinsResponse>
  broadcasts(
    cleanupId: string,
    range: AnalyticsRange,
    viewerScope: string,
  ): Promise<EventAnalyticsBroadcastsResponse>
  sources(
    cleanupId: string,
    range: AnalyticsRange,
    viewerScope: string,
  ): Promise<EventAnalyticsSourcesResponse>
  portfolio(
    userId: string,
    organizationId: string | null,
    range: PortfolioAnalyticsRange,
    viewerScope: string,
  ): Promise<HostedEventsAnalyticsResponse>
}

export function makeAnalyticsService(deps: AnalyticsServiceDeps): AnalyticsService {
  const now = deps.now ?? (() => new Date())

  function rangeWindow(days: number | null): { from: string; to: string } {
    const to = now()
    const span = days ?? ALL_RANGE_DAYS
    const from = new Date(to.getTime() - (span - 1) * 86_400_000)
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
  }

  async function timezoneOf(cleanupId: string): Promise<string> {
    return (await deps.metrics.eventTimezone(cleanupId)) ?? "UTC"
  }

  function envelope<T extends AnalyticsRange>(range: T) {
    return { generatedAt: now().toISOString(), range, k: ANALYTICS_SUPPRESSION_K }
  }

  function cached<T>(
    endpoint: string,
    scope: string,
    range: string,
    viewerScope: string,
    compute: () => Promise<T>,
  ): Promise<T> {
    return deps.cache.getOrSet(
      hostAnalyticsCacheKey({ endpoint, scope, range, viewerScope }),
      compute,
    )
  }

  return {
    overview(cleanupId, range, viewerScope) {
      return cached("overview", cleanupId, range, viewerScope, async () => {
        const window = rangeWindow(RANGE_DAYS[range])
        const timezone = await timezoneOf(cleanupId)
        const [kpis, metricRows, registrationDays, cancellationDays] = await Promise.all([
          deps.analytics.eventKpis(cleanupId),
          deps.metrics.read(
            cleanupId,
            ["page_views", "donation_clicks"],
            window.from,
            window.to,
          ),
          deps.analytics.registrationsByDay(cleanupId, timezone, window.from, window.to),
          deps.analytics.cancellationsByDay(cleanupId, timezone, window.from, window.to),
        ])
        const registeredPublishable = closureAllowsTotal(closureOf(registrationDays, window))
        const cancelledPublishable = closureAllowsTotal(closureOf(cancellationDays, window))
        const pageViews = sumMetric(metricRows, "page_views")
        const donationClicks = sumMetric(metricRows, "donation_clicks")
        const steps: KeyCount[] = [
          { key: "page_views", count: pageViews },
          { key: "registered", count: kpis.registered },
          { key: "checked_in", count: kpis.checkedIn },
        ]
        const derivedFunnel = funnel(steps)
        return {
          ...envelope(range),
          kpis: {
            registered: registeredPublishable ? suppressCount(kpis.registered).value : null,
            checkedIn: suppressCount(kpis.checkedIn).value,
            waitlisted: suppressCount(kpis.waitlisted).value,
            cancelled: cancelledPublishable ? suppressCount(kpis.cancelled).value : null,
            noShow: suppressCount(kpis.noShow).value,
            capacity: kpis.capacity,
            pageViews: suppressCount(pageViews).value,
            donationClicks: suppressCount(donationClicks).value,
          },
          checkInRate: registeredPublishable
            ? toRate(kpis.checkedIn, kpis.registered)
            : emptyRate(),
          noShowRate: registeredPublishable ? toRate(kpis.noShow, kpis.registered) : emptyRate(),
          capacityUtilization:
            kpis.capacity === null || kpis.capacity === 0 || !registeredPublishable
              ? emptyRate()
              : toRate(kpis.registered, kpis.capacity),
          funnel: toFunnelSteps(derivedFunnel).map((step) =>
            step.step === "registered" && !registeredPublishable
              ? { ...step, value: null, suppressed: true }
              : step,
          ),
        }
      })
    },

    registrations(cleanupId, range, viewerScope) {
      return cached("registrations", cleanupId, range, viewerScope, async () => {
        const window = rangeWindow(RANGE_DAYS[range])
        const timezone = await timezoneOf(cleanupId)
        const [series, cancellations, byType, byAudience, waitlist] = await Promise.all([
          deps.analytics.registrationsByDay(cleanupId, timezone, window.from, window.to),
          deps.analytics.cancellationsByDay(cleanupId, timezone, window.from, window.to),
          deps.analytics.registrationsByTicketType(cleanupId),
          deps.analytics.registrationsByAudience(cleanupId),
          deps.analytics.waitlistConversion(cleanupId),
        ])
        const closure = closureOf(series, window)
        const registeredPublishable = closureAllowsTotal(closure)
        return {
          ...envelope(range),
          series: toSeries(closure.daily),
          cumulative: toSeries(closure.cumulative),
          byTicketType: toPanel(breakdown(byType, { totalPublishable: registeredPublishable })),
          byAudience: toPanel(breakdown(byAudience, { totalPublishable: registeredPublishable })),
          cancellations: toSeries(dailySeries(cancellations, window, { suppressPoints: true }).points),
          waitlistConversion: toRate(waitlist.promoted, waitlist.joined),
        }
      })
    },

    checkins(cleanupId, range, viewerScope) {
      return cached("checkins", cleanupId, range, viewerScope, async () => {
        const window = rangeWindow(RANGE_DAYS[range])
        const timezone = await timezoneOf(cleanupId)
        const [kpis, offsets, byType, bySlot, registrationDays] = await Promise.all([
          deps.analytics.eventKpis(cleanupId),
          deps.analytics.arrivalOffsets(cleanupId, ARRIVAL_SAMPLE_LIMIT),
          deps.analytics.checkinsByTicketType(cleanupId),
          deps.analytics.checkinsBySlot(cleanupId),
          deps.analytics.registrationsByDay(cleanupId, timezone, window.from, window.to),
        ])
        const registeredPublishable = closureAllowsTotal(closureOf(registrationDays, window))
        const curve = arrivalsCurve(offsets, { suppressPoints: true })
        const arrivalsPublishable = curve.total !== null
        return {
          ...envelope(range),
          arrivals: curve.rows.map((row) => ({
            day: String(row.offsetMinutes),
            value: arrivalsPublishable ? row.value : null,
            suppressed: !arrivalsPublishable || row.suppressed,
          })),
          checkInRate: registeredPublishable
            ? toRate(kpis.checkedIn, kpis.registered)
            : emptyRate(),
          noShowRate: registeredPublishable ? toRate(kpis.noShow, kpis.registered) : emptyRate(),
          byTicketType: toPanel(breakdown(byType)),
          bySlot: toPanel(breakdown(bySlot)),
        }
      })
    },

    broadcasts(cleanupId, range, viewerScope) {
      return cached("broadcasts", cleanupId, range, viewerScope, async () => {
        const window = rangeWindow(RANGE_DAYS[range])
        const [rows, broadcastsSent] = await Promise.all([
          deps.metrics.read(
            cleanupId,
            [
              "broadcast_recipients",
              "broadcast_sent",
              "broadcast_failed",
              "broadcast_suppressed",
              "unsubscribes",
            ],
            window.from,
            window.to,
          ),
          deps.analytics.broadcastsSent(cleanupId, window.from, window.to),
        ])
        const recipients = sumMetric(rows, "broadcast_recipients")
        const channels: Array<"inapp" | "push" | "email" | "sms"> = [
          "inapp",
          "push",
          "email",
          "sms",
        ]
        const sentByChannel = channelColumn(rows, "broadcast_sent", channels)
        const failedByChannel = channelColumn(rows, "broadcast_failed", channels)
        const suppressedByChannel = channelColumn(rows, "broadcast_suppressed", channels)
        return {
          ...envelope(range),
          broadcastsSent,
          recipients: suppressCount(recipients).value,
          unsubscribes: suppressCount(sumMetric(rows, "unsubscribes")).value,
          byChannel: channels.map((channel) => ({
            channel,
            sent: sentByChannel.get(channel) ?? null,
            failed: failedByChannel.get(channel) ?? null,
            suppressed: suppressedByChannel.get(channel) ?? null,
          })),
          series: toSeries(
            dailySeries(seriesOf(rows, "broadcast_sent"), window).points,
          ),
        }
      })
    },

    sources(cleanupId, range, viewerScope) {
      return cached("sources", cleanupId, range, viewerScope, async () => {
        const window = rangeWindow(RANGE_DAYS[range])
        const rows = await deps.metrics.read(
          cleanupId,
          ["page_views", "source", "donation_clicks"],
          window.from,
          window.to,
        )
        const byBucket = new Map<string, number>()
        for (const row of rows) {
          if (row.metric !== "source") continue
          byBucket.set(row.bucket, (byBucket.get(row.bucket) ?? 0) + row.value)
        }
        return {
          ...envelope(range),
          pageViews: toSeries(dailySeries(seriesOf(rows, "page_views"), window).points),
          bySource: toPanel(
            breakdown([...byBucket].map(([key, count]) => ({ key, count }))),
          ),
          donationClicks: suppressCount(sumMetric(rows, "donation_clicks")).value,
        }
      })
    },

    portfolio(userId, organizationId, range, viewerScope) {
      const scope = organizationId === null ? `portfolio:${userId}` : `org:${organizationId}`
      return cached("portfolio", scope, range, viewerScope, async () => {
        const window = rangeWindow(PORTFOLIO_RANGE_DAYS[range])
        const cleanupIds = await deps.analytics.hostedEventIds(
          userId,
          organizationId,
          PORTFOLIO_EVENT_LIMIT,
        )
        const [totals, byEvent, dayTime, metricRows] = await Promise.all([
          deps.analytics.portfolioTotals(cleanupIds),
          deps.analytics.portfolioByEvent(cleanupIds, 50),
          deps.analytics.portfolioDayTime(cleanupIds),
          deps.metrics.readMany(cleanupIds, ["registrations"], window.from, window.to),
        ])
        const closure = closureOf(seriesOf(metricRows, "registrations"), window)
        const registrationsPublishable = closureAllowsTotal(closure)
        const best = registrationsPublishable ? bestDayTime(dayTime) : null
        return {
          generatedAt: now().toISOString(),
          range,
          k: ANALYTICS_SUPPRESSION_K,
          totals: {
            events: totals.events,
            registrations: registrationsPublishable
              ? suppressCount(totals.registrations).value
              : null,
            checkIns: suppressCount(totals.checkIns).value,
            uniqueAttendees: suppressCount(totals.uniqueAttendees).value,
          },
          series: toSeries(closure.daily),
          byEvent: toPanel(breakdown(byEvent, { totalPublishable: registrationsPublishable })),
          repeatAttendance: toSuppressedRate(
            repeatAttendanceRate(totals.repeatAttendees, totals.uniqueAttendees),
            totals.repeatAttendees,
            totals.uniqueAttendees,
          ),
          averageCheckInRate: registrationsPublishable
            ? toRate(totals.checkIns, totals.registrations)
            : emptyRate(),
          bestDayTime:
            best === null
              ? null
              : { weekday: best.weekday, hour: best.hour, value: best.value, suppressed: false },
        }
      })
    },
  }
}

function closureOf(points: readonly DayCount[], window: { from: string; to: string }) {
  return seriesClosure(points, window, { suppressPoints: true })
}

function closureAllowsTotal(closure: SeriesClosure): boolean {
  return closure.panelSuppressed || closure.totalPublishable
}

function channelColumn(
  rows: readonly MetricRow[],
  metric: string,
  channels: readonly string[],
): Map<string, number | null> {
  const panel = breakdown(
    channels.map((channel) => ({ key: channel, count: sumMetric(rows, metric, channel) })),
  )
  return new Map(panel.rows.map((row) => [row.key, row.value]))
}

function sumMetric(rows: readonly MetricRow[], metric: string, bucket?: string): number {
  return rows
    .filter((row) => row.metric === metric && (bucket === undefined || row.bucket === bucket))
    .reduce((acc, row) => acc + row.value, 0)
}

function seriesOf(rows: readonly MetricRow[], metric: string): DayCount[] {
  const byDay = new Map<string, number>()
  for (const row of rows) {
    if (row.metric !== metric) continue
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.value)
  }
  return [...byDay].map(([day, count]) => ({ day, count }))
}

function toSeries(
  points: readonly { day: string; value: number | null; suppressed: boolean }[],
): SeriesPoint[] {
  return points.map((point) => ({
    day: point.day,
    value: point.value,
    suppressed: point.suppressed,
  }))
}

function toPanel(panel: DerivedPanel<DerivedBreakdownRow>): Panel {
  return {
    panelSuppressed: panel.panelSuppressed,
    rows: panel.rows.map(
      (row): BreakdownRow => ({
        key: row.key,
        label: row.key,
        value: row.value,
        suppressed: row.suppressed,
      }),
    ),
  }
}

function toFunnelSteps(panel: DerivedPanel<{ key: string; value: number | null; suppressed: boolean }>): FunnelStep[] {
  return panel.rows.map((row) => ({
    step: row.key,
    label: row.key,
    value: row.value,
    suppressed: row.suppressed,
  }))
}

function toRate(numerator: number, denominator: number): SuppressedRate {
  const ratio = suppressRate(numerator, denominator)
  return toSuppressedRate(ratio, numerator, denominator)
}

function toSuppressedRate(
  ratio: { value: number | null; suppressed: boolean },
  numerator: number,
  denominator: number,
): SuppressedRate {
  return {
    value: ratio.value,
    numerator: ratio.suppressed ? null : numerator,
    denominator: ratio.suppressed ? null : denominator,
    suppressed: ratio.suppressed,
  }
}

function emptyRate(): SuppressedRate {
  return { value: null, numerator: null, denominator: null, suppressed: true }
}
