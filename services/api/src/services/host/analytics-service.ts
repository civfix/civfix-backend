import {
  ANALYTICS_SUPPRESSION_K,
  MAX_PORTFOLIO_TOP_VOLUNTEERS,
  type AnalyticsRange,
  type BroadcastChannel,
  type EventAnalyticsBroadcastsResponse,
  type EventAnalyticsCheckinsResponse,
  type EventAnalyticsOverviewResponse,
  type EventAnalyticsRegistrationsResponse,
  type EventAnalyticsSourcesResponse,
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
  type KeyCount,
} from "@civfix/shared/host"
import type { AnalyticsRepository, LabeledKeyCount } from "./analytics-repository.js"
import type { MetricRow, MetricsRepository } from "./metrics-repository.js"
import { leaderboardEntryOf } from "../volunteer-hours-service.js"
import { hostAnalyticsCacheKey, type HostAnalyticsCache } from "./host-analytics-cache.js"
import { eventDayKey } from "./event-day.js"
import { DEFAULT_EVENT_TIME_ZONE } from "./event-fields.js"
import {
  METRIC_BROADCAST_FAILED,
  METRIC_BROADCAST_RECIPIENTS,
  METRIC_BROADCAST_SENT,
  METRIC_BROADCAST_SUPPRESSED,
  METRIC_DONATION_CLICKS,
  METRIC_PAGE_VIEWS,
  METRIC_REGISTRATIONS,
  METRIC_SOURCE,
  METRIC_UNSUBSCRIBES,
} from "./event-metric-names.js"
import {
  PORTFOLIO_EVENT_LIMIT,
  closureAllowsTotal,
  emptyRate,
  isoDayOf,
  metricTotal,
  seriesOf,
  shiftDayKey,
  toFunnelSteps,
  toPanel,
  toRate,
  toSeries,
  toSuppressedRate,
} from "./host-analytics-shaping.js"
import { MS_PER_DAY } from "../../lib/time.js"

export const ARRIVAL_SAMPLE_LIMIT = 20_000
const PORTFOLIO_BY_EVENT_LIMIT = 50

const RANGE_DAYS: Record<AnalyticsRange, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
}
const PORTFOLIO_RANGE_DAYS: Record<PortfolioAnalyticsRange, number | null> = {
  "30d": 30,
  "90d": 90,
  "365d": 365,
  all: null,
}

const ALL_RANGE_DAYS = 365

const EXACT_K = 1

const BROADCAST_CHANNELS: readonly BroadcastChannel[] = ["inapp", "push", "email", "sms"]

export interface AnalyticsServiceDeps {
  analytics: AnalyticsRepository
  metrics: MetricsRepository
  cache: HostAnalyticsCache
  now?: () => Date
}

export interface AnalyticsService {
  overview(
    cleanupId: string,
    range: AnalyticsRange,
    viewerScope: string,
  ): Promise<EventAnalyticsOverviewResponse>
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
    const from = new Date(to.getTime() - (span - 1) * MS_PER_DAY)
    return { from: isoDayOf(from), to: isoDayOf(to) }
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
        const [kpis, metricRows, registrationDays] = await Promise.all([
          deps.analytics.eventKpis(cleanupId),
          deps.metrics.read(
            cleanupId,
            [METRIC_PAGE_VIEWS, METRIC_DONATION_CLICKS],
            window.from,
            window.to,
          ),
          deps.analytics.registrationsByDay(cleanupId, timezone, window.from, window.to),
        ])
        const registeredPublishable = closureAllowsTotal(closureOf(registrationDays, window))
        const pageViews = metricTotal(metricRows, METRIC_PAGE_VIEWS)
        const donationClicks = metricTotal(metricRows, METRIC_DONATION_CLICKS)
        const steps: KeyCount[] = [
          ...(pageViews === null ? [] : [{ key: "page_views", count: pageViews }]),
          { key: "registered", count: kpis.registered },
          { key: "checked_in", count: kpis.checkedIn },
        ]
        const derivedFunnel = funnel(steps)
        return {
          ...envelope(range),
          kpis: {
            registered: kpis.registered,
            checkedIn: kpis.checkedIn,
            waitlisted: kpis.waitlisted,
            cancelled: kpis.cancelled,
            noShow: kpis.noShow,
            capacity: kpis.capacity,
            pageViews,
            donationClicks,
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
          cancellations: toSeries(
            dailySeries(cancellations, window, { suppressPoints: true }).points,
          ),
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
              METRIC_BROADCAST_RECIPIENTS,
              METRIC_BROADCAST_SENT,
              METRIC_BROADCAST_FAILED,
              METRIC_BROADCAST_SUPPRESSED,
              METRIC_UNSUBSCRIBES,
            ],
            window.from,
            window.to,
          ),
          deps.analytics.broadcastsSent(cleanupId, timezone, window.from, window.to),
        ])
        const recipients = sumMetric(rows, METRIC_BROADCAST_RECIPIENTS)
        const sentByChannel = channelColumn(rows, METRIC_BROADCAST_SENT)
        const failedByChannel = channelColumn(rows, METRIC_BROADCAST_FAILED)
        const suppressedByChannel = channelColumn(rows, METRIC_BROADCAST_SUPPRESSED)
        return {
          ...envelope(range),
          broadcastsSent,
          recipients: suppressCount(recipients).value,
          unsubscribes: suppressCount(sumMetric(rows, METRIC_UNSUBSCRIBES)).value,
          byChannel: BROADCAST_CHANNELS.map((channel) => ({
            channel,
            sent: sentByChannel.get(channel) ?? null,
            failed: failedByChannel.get(channel) ?? null,
            suppressed: suppressedByChannel.get(channel) ?? null,
          })),
          series: toSeries(dailySeries(seriesOf(rows, METRIC_BROADCAST_SENT), window).points),
        }
      })
    },

    sources(cleanupId, range, viewerScope) {
      return cached("sources", cleanupId, range, viewerScope, async () => {
        const timezone = await timezoneOf(cleanupId)
        const window = eventRangeWindow(RANGE_DAYS[range], timezone)
        const rows = await deps.metrics.read(
          cleanupId,
          [METRIC_PAGE_VIEWS, METRIC_SOURCE, METRIC_DONATION_CLICKS],
          window.from,
          window.to,
        )
        const byBucket = new Map<string, number>()
        for (const row of rows) {
          if (row.metric !== METRIC_SOURCE) continue
          byBucket.set(row.bucket, (byBucket.get(row.bucket) ?? 0) + row.value)
        }
        return {
          ...envelope(range),
          pageViews: toSeries(dailySeries(seriesOf(rows, METRIC_PAGE_VIEWS), window).points),
          bySource: toPanel(breakdown([...byBucket].map(([key, count]) => ({ key, count })))),
          donationClicks: suppressCount(sumMetric(rows, METRIC_DONATION_CLICKS)).value,
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
          deps.analytics.portfolioByEvent(cleanupIds, PORTFOLIO_BY_EVENT_LIMIT),
          deps.analytics.portfolioDayTime(cleanupIds),
          deps.metrics.readMany(cleanupIds, [METRIC_REGISTRATIONS], window.from, window.to),
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
          series: exactSeries(seriesOf(metricRows, METRIC_REGISTRATIONS), window),
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
          deps.metrics.readMany(cleanupIds, [METRIC_DONATION_CLICKS], window.from, window.to),
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
            donationClicks: sumMetric(metricRows, METRIC_DONATION_CLICKS),
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
  const to = new Date(Date.parse(`${window.to}T00:00:00.000Z`) + MS_PER_DAY)
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

function channelColumn(rows: readonly MetricRow[], metric: string): Map<string, number | null> {
  const panel = breakdown(
    BROADCAST_CHANNELS.map((channel) => ({
      key: channel,
      count: sumMetric(rows, metric, channel),
    })),
  )
  return new Map(panel.rows.map((row) => [row.key, row.value]))
}

function sumMetric(rows: readonly MetricRow[], metric: string, bucket?: string): number {
  return rows
    .filter((row) => row.metric === metric && (bucket === undefined || row.bucket === bucket))
    .reduce((acc, row) => acc + row.value, 0)
}
