import {
  ANALYTICS_SUPPRESSION_K,
  AppError,
  EVENT_ANALYTICS_CARD_SERIES_POINTS,
  EVENT_ANALYTICS_CARD_SLOT_ROWS,
  EVENT_ANALYTICS_COMPARISON_MIN_EVENTS,
  EVENT_ANALYTICS_COMPARISON_WINDOW,
  MAX_EVENT_ANALYTICS_ARRIVAL_BUCKETS,
  MAX_EVENT_ANALYTICS_PANEL_ROWS,
  MAX_EVENT_ANALYTICS_SERIES_POINTS,
  type BreakdownRow,
  type EventAnalyticsPhase,
  type EventAnalyticsScope,
  type GetEventAnalyticsResponse,
  type Panel,
  type SeriesPoint,
} from "@civfix/shared"
import {
  breakdown,
  dailySeries,
  funnel,
  seriesClosure,
  type DayCount,
  type DayRange,
  type DerivedBreakdownRow,
  type DerivedPanel,
  type KeyCount,
} from "@civfix/shared/host"
import type {
  AnalyticsRepository,
  EventClockRecord,
  EventHoursTotals,
  EventKpiRow,
  SourceSeats,
} from "./analytics-repository.drizzle.js"
import type {
  EventAnalyticsFacts,
  EventAnalyticsRepository,
} from "./event-analytics-repository.drizzle.js"
import type { MetricRow, MetricsRepository } from "./metrics-repository.drizzle.js"
import {
  hostAnalyticsCacheKey,
  perViewerScope,
  type HostAnalyticsCache,
} from "./host-analytics-cache.js"
import { eventDayKey } from "./event-day.js"
import { DEFAULT_EVENT_TIME_ZONE } from "./event-fields.js"
import { ARRIVAL_SAMPLE_LIMIT } from "./analytics-service.js"
import { METRIC_DONATION_CLICKS, METRIC_PAGE_VIEWS } from "./event-metric-names.js"
import {
  DAY_MS,
  clockPhase,
  closureAllowsTotal,
  emptyRate,
  metricTotal,
  seriesOf,
  shiftDayKey,
  toFunnelSteps,
  toRate,
  toSeries,
} from "./host-analytics-shaping.js"

const EVENT_ANALYTICS_LIFECYCLE_DAYS = MAX_EVENT_ANALYTICS_SERIES_POINTS
const EVENT_ANALYTICS_ARCHIVE_DAYS = 30
const EVENT_ANALYTICS_ARRIVAL_BUCKET_MIN = 15
const EVENT_ANALYTICS_DELTA_DAYS = 7
const EVENT_ANALYTICS_CACHE_ENDPOINT = "event-analytics"
const FULL_SCOPE: EventAnalyticsScope = "full"

export interface EventAnalyticsServiceDeps {
  analytics: AnalyticsRepository
  events: EventAnalyticsRepository
  metrics: MetricsRepository
  cache: HostAnalyticsCache
  now?: () => Date
}

export interface EventAnalyticsViewer {
  userId: string
  organizationId: string | null
  viewerScope: string
}

export interface EventAnalyticsService {
  analytics(
    cleanupId: string,
    scope: EventAnalyticsScope,
    viewer: EventAnalyticsViewer,
  ): Promise<GetEventAnalyticsResponse>
}

function toPanel(panel: DerivedPanel<DerivedBreakdownRow>): Panel {
  return {
    panelSuppressed: panel.panelSuppressed,
    rows: panel.rows.slice(0, MAX_EVENT_ANALYTICS_PANEL_ROWS).map(
      (row): BreakdownRow => ({
        key: row.key,
        label: row.key,
        value: row.value,
        suppressed: row.suppressed,
      }),
    ),
  }
}

function tailSum(points: readonly { value: number | null }[], days: number): number | null {
  const tail = points.slice(-days)
  let total = 0
  for (const point of tail) {
    if (point.value === null) return null
    total += point.value
  }
  return total
}

function cardSlotPanel(
  rows: readonly KeyCount[],
  registeredPublishable: boolean,
  full: boolean,
): Panel {
  const panel = toPanel(breakdown(rows, { totalPublishable: registeredPublishable }))
  if (full) return panel
  return { ...panel, rows: panel.rows.slice(0, EVENT_ANALYTICS_CARD_SLOT_ROWS) }
}

export function analyticsPhaseOf(clock: EventClockRecord, at: Date): EventAnalyticsPhase {
  const phase = clockPhase(clock, at)
  if (phase === "live") return "day_of"
  if (phase !== "ended") return "upcoming"
  const endedAt = clock.completedAt ?? clock.endsAt ?? clock.scheduledAt
  return at.getTime() - endedAt.getTime() > EVENT_ANALYTICS_ARCHIVE_DAYS * DAY_MS
    ? "archived"
    : "completed"
}

export function arrivalBuckets(offsets: readonly number[]): SeriesPoint[] {
  const byBucket = new Map<number, number>()
  for (const offset of offsets) {
    const bucket = Math.floor(offset / EVENT_ANALYTICS_ARRIVAL_BUCKET_MIN)
    byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + 1)
  }
  return [...byBucket]
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_EVENT_ANALYTICS_ARRIVAL_BUCKETS)
    .map(([bucket, count]) => ({
      day: String(bucket * EVENT_ANALYTICS_ARRIVAL_BUCKET_MIN),
      value: count,
      suppressed: false,
    }))
}

interface EventAnalyticsInputs {
  kpis: EventKpiRow
  facts: EventAnalyticsFacts
  metricRows: MetricRow[]
  registrationDays: DayCount[]
  cancellationDays: DayCount[]
  offsets: number[]
  waitlist: { promoted: number; joined: number }
  hours: EventHoursTotals
  bySource: SourceSeats[]
  registrationsBySlot: KeyCount[]
  checkinsBySlot: KeyCount[]
  hoursBuckets: KeyCount[]
  reportStatuses: KeyCount[]
  comparison: GetEventAnalyticsResponse["comparison"]
}

interface EventAnalyticsContext {
  scope: EventAnalyticsScope
  phase: EventAnalyticsPhase
  clock: EventClockRecord
  at: Date
  window: DayRange
  full: boolean
}

function kpisOf(
  inputs: EventAnalyticsInputs,
  pageViews: number | null,
  donationClicks: number | null,
): GetEventAnalyticsResponse["kpis"] {
  const { kpis, facts, hours } = inputs
  return {
    signups: kpis.registered,
    capacity: kpis.capacity,
    waitlisted: kpis.waitlisted,
    cancelled: kpis.cancelled,
    checkedIn: kpis.checkedIn,
    noShow: kpis.noShow,
    walkUps: facts.walkUps,
    pageViews,
    uniqueViewers: null,
    shares: null,
    donationClicks,
    hoursTotal: hours.credited,
    hoursVolunteers: hours.attendeesCredited,
    reportsLinked: facts.reportsLinked,
    reportsResolved: facts.reportsResolved,
    postsCreated: facts.postsCreated,
  }
}

function ratesOf(
  inputs: EventAnalyticsInputs,
  pageViews: number | null,
  registeredPublishable: boolean,
): GetEventAnalyticsResponse["rates"] {
  const { kpis, waitlist } = inputs
  return {
    checkIn: registeredPublishable ? toRate(kpis.checkedIn, kpis.registered) : emptyRate(),
    noShow: registeredPublishable ? toRate(kpis.noShow, kpis.registered) : emptyRate(),
    fill:
      kpis.capacity === null || kpis.capacity === 0 || !registeredPublishable
        ? emptyRate()
        : toRate(kpis.registered, kpis.capacity),
    viewToSignup:
      pageViews === null || pageViews === 0 || !registeredPublishable
        ? emptyRate()
        : toRate(kpis.registered, pageViews),
    waitlistConversion: toRate(waitlist.promoted, waitlist.joined),
  }
}

function shapeResponse(
  inputs: EventAnalyticsInputs,
  ctx: EventAnalyticsContext,
): GetEventAnalyticsResponse {
  const { window, full, clock } = ctx
  const closure = seriesClosure(inputs.registrationDays, window, { suppressPoints: true })
  const registeredPublishable = closureAllowsTotal(closure)
  const cancellations = dailySeries(inputs.cancellationDays, window, { suppressPoints: true })
  const viewsSeries = dailySeries(seriesOf(inputs.metricRows, METRIC_PAGE_VIEWS), window)
  const pageViews = metricTotal(inputs.metricRows, METRIC_PAGE_VIEWS)
  const donationClicks = metricTotal(inputs.metricRows, METRIC_DONATION_CLICKS)

  const steps: KeyCount[] = [
    { key: "signups", count: inputs.kpis.registered },
    { key: "checked_in", count: inputs.kpis.checkedIn },
    { key: "logged_hours", count: inputs.hours.attendeesCredited },
  ]

  const cumulative = toSeries(closure.cumulative)
  const daily = toSeries(closure.daily)
  const viewsDaily = toSeries(viewsSeries.points)
  const arrivals = arrivalBuckets(inputs.offsets)

  return {
    generatedAt: ctx.at.toISOString(),
    k: ANALYTICS_SUPPRESSION_K,
    scope: ctx.scope,
    phase: ctx.phase,
    lifecycle: {
      createdAt: clock.createdAt.toISOString(),
      startAt: clock.scheduledAt.toISOString(),
      endAt: clock.endsAt?.toISOString() ?? null,
      completedAt: clock.completedAt?.toISOString() ?? null,
    },
    kpis: kpisOf(inputs, pageViews, donationClicks),
    rates: ratesOf(inputs, pageViews, registeredPublishable),
    deltas: {
      signups7d: tailSum(daily, EVENT_ANALYTICS_DELTA_DAYS),
      views7d: tailSum(viewsDaily, EVENT_ANALYTICS_DELTA_DAYS),
    },
    signups: {
      cumulative: full ? cumulative : cumulative.slice(-EVENT_ANALYTICS_CARD_SERIES_POINTS),
      daily: full ? daily : [],
      cancellations: full ? toSeries(cancellations.points) : [],
      bySlot: cardSlotPanel(inputs.registrationsBySlot, registeredPublishable, full),
      ...(full
        ? {
            bySource: toPanel(
              breakdown(
                inputs.bySource.map((row) => ({ key: row.source, count: row.seats })),
                { totalPublishable: registeredPublishable },
              ),
            ),
          }
        : {}),
    },
    reach: {
      viewsDaily: full ? viewsDaily : viewsDaily.slice(-EVENT_ANALYTICS_CARD_SERIES_POINTS),
      funnel: full ? toFunnelSteps(funnel(steps)) : [],
    },
    eventDay: {
      arrivals: full ? arrivals : arrivals.slice(-EVENT_ANALYTICS_CARD_SERIES_POINTS),
      ...(full ? { bySlot: toPanel(breakdown(inputs.checkinsBySlot)) } : {}),
    },
    impact: full
      ? {
          hoursBuckets: toPanel(breakdown(inputs.hoursBuckets)),
          reportStatuses: toPanel(breakdown(inputs.reportStatuses)),
        }
      : {},
    comparison: inputs.comparison,
  }
}

export function makeEventAnalyticsService(deps: EventAnalyticsServiceDeps): EventAnalyticsService {
  const now = deps.now ?? (() => new Date())

  function lifecycleWindow(clock: EventClockRecord, timezone: string): DayRange {
    const to = eventDayKey(now(), timezone)
    const from = eventDayKey(clock.createdAt, timezone)
    const earliest = shiftDayKey(to, 1 - EVENT_ANALYTICS_LIFECYCLE_DAYS)
    return { from: from < earliest ? earliest : from, to }
  }

  async function comparisonOf(
    cleanupId: string,
    viewer: EventAnalyticsViewer,
  ): Promise<GetEventAnalyticsResponse["comparison"]> {
    const ids = await deps.events.previousCompletedEventIds({
      userId: viewer.userId,
      organizationId: viewer.organizationId,
      excludeCleanupId: cleanupId,
      limit: EVENT_ANALYTICS_COMPARISON_WINDOW,
    })
    if (ids.length < EVENT_ANALYTICS_COMPARISON_MIN_EVENTS) return null
    const medians = await deps.events.comparisonMedians(ids)
    return {
      sampleSize: medians.sampleSize,
      medians: {
        signups: medians.signups,
        checkInRate: medians.checkInRate,
        hoursPerVolunteer: medians.hoursPerVolunteer,
        fillRate: medians.fillRate,
      },
    }
  }

  async function loadInputs(
    cleanupId: string,
    viewer: EventAnalyticsViewer,
    timezone: string,
    window: DayRange,
    full: boolean,
  ): Promise<EventAnalyticsInputs> {
    const [
      kpis,
      facts,
      metricRows,
      registrationDays,
      cancellationDays,
      offsets,
      waitlist,
      hours,
      bySource,
      registrationsBySlot,
      checkinsBySlot,
      hoursBuckets,
      reportStatuses,
      comparison,
    ] = await Promise.all([
      deps.analytics.eventKpis(cleanupId),
      deps.events.facts(cleanupId),
      deps.metrics.read(
        cleanupId,
        [METRIC_PAGE_VIEWS, METRIC_DONATION_CLICKS],
        window.from,
        window.to,
      ),
      deps.analytics.registrationsByDay(cleanupId, timezone, window.from, window.to),
      deps.analytics.cancellationsByDay(cleanupId, timezone, window.from, window.to),
      deps.analytics.arrivalOffsets(cleanupId, ARRIVAL_SAMPLE_LIMIT),
      deps.analytics.waitlistConversion(cleanupId),
      deps.analytics.eventHoursTotals(cleanupId),
      deps.analytics.registrationsBySource(cleanupId),
      deps.events.registrationsBySlot(cleanupId),
      full ? deps.analytics.checkinsBySlot(cleanupId) : Promise.resolve<KeyCount[]>([]),
      full ? deps.events.hoursBuckets(cleanupId) : Promise.resolve<KeyCount[]>([]),
      full ? deps.events.reportStatuses(cleanupId) : Promise.resolve<KeyCount[]>([]),
      full ? comparisonOf(cleanupId, viewer) : Promise.resolve(null),
    ])
    return {
      kpis,
      facts,
      metricRows,
      registrationDays,
      cancellationDays,
      offsets,
      waitlist,
      hours,
      bySource,
      registrationsBySlot,
      checkinsBySlot,
      hoursBuckets,
      reportStatuses,
      comparison,
    }
  }

  async function compute(
    cleanupId: string,
    scope: EventAnalyticsScope,
    viewer: EventAnalyticsViewer,
    clock: EventClockRecord,
    phase: EventAnalyticsPhase,
    at: Date,
  ): Promise<GetEventAnalyticsResponse> {
    const timezone = clock.timezone ?? DEFAULT_EVENT_TIME_ZONE
    const window = lifecycleWindow(clock, timezone)
    const full = scope === FULL_SCOPE
    const inputs = await loadInputs(cleanupId, viewer, timezone, window, full)
    return shapeResponse(inputs, { scope, phase, clock, at, window, full })
  }

  return {
    async analytics(cleanupId, scope, viewer) {
      const clock = await deps.analytics.eventClock(cleanupId)
      if (clock === null) throw AppError.notFound("Cleanup not found")
      const at = now()
      const phase = analyticsPhaseOf(clock, at)
      const generation = await deps.cache.generationOf(cleanupId)
      return deps.cache.getOrSet(
        hostAnalyticsCacheKey({
          endpoint: EVENT_ANALYTICS_CACHE_ENDPOINT,
          scope: cleanupId,
          range: `${scope}:${phase}`,
          viewerScope: perViewerScope(viewer),
          generation,
        }),
        () => compute(cleanupId, scope, viewer, clock, phase, at),
      )
    },
  }
}
