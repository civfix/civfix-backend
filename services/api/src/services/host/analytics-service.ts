import {
  ANALYTICS_SUPPRESSION_K,
  MAX_PORTFOLIO_TOP_VOLUNTEERS,
  type AnalyticsRange,
  type BreakdownRow,
  type EventAnalyticsBroadcastsResponse,
  type EventAnalyticsCheckinsResponse,
  type EventAnalyticsOverviewResponse,
  type EventAnalyticsRegistrationsResponse,
  type EventAnalyticsSourcesResponse,
  type FunnelStep,
  type HostAnalyticsSummaryResponse,
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
  enumerateDays,
  funnel,
  seriesClosure,
  suppressCount,
  suppressRate,
  type DayCount,
  type DayRange,
  type DerivedBreakdownRow,
  type DerivedPanel,
  type KeyCount,
  type SeriesClosure,
} from "@civfix/shared/host"
import type { AnalyticsRepository, LabeledKeyCount } from "./analytics-repository.drizzle.js"
import { leaderboardEntryOf } from "../volunteer-hours-service.js"
import type { MetricRow, MetricsRepository } from "./metrics-repository.drizzle.js"
import { hostAnalyticsCacheKey, type HostAnalyticsCache } from "./host-analytics-cache.js"
import { eventDayKey } from "./event-day.js"
import { DEFAULT_EVENT_TIME_ZONE } from "./event-fields.js"

function shiftDayKey(day: string, deltaDays: number): string {
  const [year, month, date] = day.split("-").map(Number)
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1) + deltaDays * 86_400_000)
  return shifted.toISOString().slice(0, 10)
}

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

const EXACT_K = 1

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
  summary(
    userId: string,
    organizationId: string | null,
    range: AnalyticsRange,
    viewerScope: string,
  ): Promise<HostAnalyticsSummaryResponse>
}

export function makeAnalyticsService(deps: AnalyticsServiceDeps): AnalyticsService {
  const now = deps.now ?? (() => new Date())

  function utcRangeWindow(days: number | null): { from: string; to: string } {
    const to = now()
    const span = days ?? ALL_RANGE_DAYS
    const from = new Date(to.getTime() - (span - 1) * 86_400_000)
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
  }

  function eventRangeWindow(days: number | null, timezone: string): { from: string; to: string } {
    const span = days ?? ALL_RANGE_DAYS
    const to = eventDayKey(now(), timezone)
    return { from: shiftDayKey(to, 1 - span), to }
  }

  async function timezoneOf(cleanupId: string): Promise<string> {
    return (await deps.metrics.eventTimezone(cleanupId)) ?? DEFAULT_EVENT_TIME_ZONE
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
        const timezone = await timezoneOf(cleanupId)
        const window = eventRangeWindow(RANGE_DAYS[range], timezone)
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
        const timezone = await timezoneOf(cleanupId)
        const window = eventRangeWindow(RANGE_DAYS[range], timezone)
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
        const timezone = await timezoneOf(cleanupId)
        const window = eventRangeWindow(RANGE_DAYS[range], timezone)
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
        const timezone = await timezoneOf(cleanupId)
        const window = eventRangeWindow(RANGE_DAYS[range], timezone)
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
          deps.analytics.broadcastsSent(cleanupId, timezone, window.from, window.to),
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
        const timezone = await timezoneOf(cleanupId)
        const window = eventRangeWindow(RANGE_DAYS[range], timezone)
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
        const window = utcRangeWindow(PORTFOLIO_RANGE_DAYS[range])
        const cleanupIds = await deps.analytics.hostedEventIds(
          userId,
          organizationId,
          PORTFOLIO_EVENT_LIMIT,
        )
        const [totals, byEvent, dayTime, metricRows, hours, topVolunteers] = await Promise.all([
          deps.analytics.portfolioTotals(cleanupIds),
          deps.analytics.portfolioByEvent(cleanupIds, 50),
          deps.analytics.portfolioDayTime(cleanupIds),
          deps.metrics.readMany(cleanupIds, ["registrations"], window.from, window.to),
          deps.analytics.hoursTotals(cleanupIds),
          deps.analytics.topVolunteers(cleanupIds, MAX_PORTFOLIO_TOP_VOLUNTEERS),
        ])
        return {
          generatedAt: now().toISOString(),
          range,
          k: ANALYTICS_SUPPRESSION_K,
          totals: {
            events: totals.events,
            registrations: totals.registrations,
            checkIns: totals.checkIns,
            uniqueAttendees: totals.uniqueAttendees,
          },
          totalHours: round2(hours.credited),
          volunteersCredited: hours.volunteersCredited,
          topVolunteers: topVolunteers.map((row, index) => leaderboardEntryOf(row, index + 1)),
          series: exactSeries(seriesOf(metricRows, "registrations"), window),
          byEvent: exactPanel(byEvent),
          repeatAttendance: exactRate(totals.repeatAttendees, totals.uniqueAttendees),
          averageCheckInRate: exactRate(totals.checkIns, totals.registrations),
          bestDayTime: toBestDayTime(bestDayTime(dayTime, EXACT_K)),
        }
      })
    },

    summary(userId, organizationId, range, viewerScope) {
      const scope = organizationId === null ? `host:${userId}` : `org:${organizationId}`
      return cached("summary", scope, range, viewerScope, async () => {
        const window = utcRangeWindow(RANGE_DAYS[range])
        const bounds = dayBounds(window)
        const cleanupIds = await deps.analytics.hostedEventIds(
          userId,
          organizationId,
          PORTFOLIO_EVENT_LIMIT,
        )
        const envelope = {
          generatedAt: now().toISOString(),
          range,
          k: ANALYTICS_SUPPRESSION_K,
          window,
        }
        if (cleanupIds.length === 0) return emptySummary(envelope, window)
        const [activity, held, signups, metricRows] = await Promise.all([
          deps.analytics.activityTotals(cleanupIds, bounds.from, bounds.to),
          deps.analytics.heldEventTotals(cleanupIds, bounds.from, bounds.to),
          deps.analytics.signupsByDayAcross(cleanupIds, window.from, window.to),
          deps.metrics.readMany(cleanupIds, ["donation_clicks"], window.from, window.to),
        ])
        return {
          ...envelope,
          activity: {
            signups: activity.registrations,
            cancellations: activity.cancellations,
            hoursTotal: round2(activity.hoursTotal),
            hoursVolunteers: activity.hoursVolunteers,
            reportsLinked: activity.reportsLinked,
            reportsResolved: activity.reportsResolved,
            postsCreated: activity.postsCreated,
            donationClicks: sumMetric(metricRows, "donation_clicks"),
          },
          eventsHeld: {
            count: held.events,
            registered: held.registered,
            checkIns: held.checkedIn,
            noShows: held.noShow,
            checkInRate: exactRate(held.checkedIn, held.registered),
          },
          totals: { events: cleanupIds.length },
          signupsDaily: exactSeries(signups.daily, window),
          byEvent: labeledPanel(signups.byEvent),
          hoursByEvent: labeledPanel(signups.hoursByEvent),
        }
      })
    },
  }
}

function dayBounds(window: DayRange): { from: Date; to: Date } {
  const from = new Date(`${window.from}T00:00:00.000Z`)
  const to = new Date(Date.parse(`${window.to}T00:00:00.000Z`) + 86_400_000)
  return { from, to }
}

function emptySummary(
  envelope: Pick<HostAnalyticsSummaryResponse, "generatedAt" | "range" | "k" | "window">,
  window: DayRange,
): HostAnalyticsSummaryResponse {
  return {
    ...envelope,
    activity: {
      signups: 0,
      cancellations: 0,
      hoursTotal: 0,
      hoursVolunteers: 0,
      reportsLinked: 0,
      reportsResolved: 0,
      postsCreated: 0,
      donationClicks: 0,
    },
    eventsHeld: {
      count: 0,
      registered: 0,
      checkIns: 0,
      noShows: 0,
      checkInRate: exactRate(0, 0),
    },
    totals: { events: 0 },
    signupsDaily: exactSeries([], window),
    byEvent: labeledPanel([]),
    hoursByEvent: labeledPanel([]),
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function exactSeries(points: readonly DayCount[], window: DayRange): SeriesPoint[] {
  const byDay = new Map<string, number>()
  for (const point of points) byDay.set(point.day, (byDay.get(point.day) ?? 0) + point.count)
  return enumerateDays(window).map((day) => ({
    day,
    value: byDay.get(day) ?? 0,
    suppressed: false,
  }))
}

function exactPanel(rows: readonly KeyCount[]): Panel {
  return {
    panelSuppressed: false,
    rows: rows.map((row) => ({
      key: row.key,
      label: row.key,
      value: row.count,
      suppressed: false,
    })),
  }
}

function labeledPanel(rows: readonly LabeledKeyCount[]): Panel {
  return {
    panelSuppressed: false,
    rows: rows.map((row) => ({
      key: row.key,
      label: row.label,
      value: row.count,
      suppressed: false,
    })),
  }
}

function exactRate(numerator: number, denominator: number): SuppressedRate {
  return toSuppressedRate(suppressRate(numerator, denominator, EXACT_K), numerator, denominator)
}

function toBestDayTime(
  best: { weekday: number; hour: number; value: number } | null,
): HostedEventsAnalyticsResponse["bestDayTime"] {
  return best === null
    ? null
    : { weekday: best.weekday, hour: best.hour, value: best.value, suppressed: false }
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
