/**
 * Admin home / dashboard service (Phase 2): the dashboard aggregate (#4) + the live-map feed (#5).
 *
 * RESILIENCE (each card can fail independently): every section is computed inside its own guard
 * (safeSection). A failing sub-aggregate degrades ONLY that section to a neutral zero block; it never 500s
 * the whole summary. The analytics mini reuses the AnalyticsRepository (so the home digest and the full
 * analytics page agree); each of its inputs is likewise guarded.
 */

import type {
  AnalyticsCoverageResponse,
  EventStatus,
  HomeMapPin,
  HomeMapResponse,
  HomeSummaryResponse,
  ReportStatus,
} from "@civfix/shared"
import type { AnalyticsRepository } from "./analytics-types.js"
import { buildCoverage, buildPinsByWeek, pct } from "./analytics-shaping.js"
import { PINS_BY_WEEK_WEEKS } from "./analytics-types.js"
import type {
  DiscoverySectionCounts,
  EventsSectionCounts,
  HomeMapPinRecord,
  HomeRepository,
  MailSectionCounts,
  ReportsSectionCounts,
  UsersSectionCounts,
} from "./home-types.js"

export * from "./home-types.js"

const ZERO_DISCOVERY: DiscoverySectionCounts = { queue: 0, reportsWaiting: 0, overSla: 0 }
const ZERO_REPORTS: ReportsSectionCounts = { flagged: 0, inProgress: 0, completed: 0 }
const ZERO_EVENTS: EventsSectionCounts = { upcoming: 0, live: 0, attending: 0 }
const ZERO_MAIL: MailSectionCounts = { unread: 0, needsAction: 0, bounceRate: 0 }
const ZERO_USERS: UsersSectionCounts = { flagged: 0, highRisk: 0, suspended: 0 }

interface AnalyticsMini {
  pinsThisMonth: number
  resolvedPct: number
  coveragePct: number
  cleanups: number
  eventsThisMonth: number
  newUsers: number
  pinsByWeek: number[]
}

const ZERO_ANALYTICS_MINI: AnalyticsMini = {
  pinsThisMonth: 0,
  resolvedPct: 0,
  coveragePct: 0,
  cleanups: 0,
  eventsThisMonth: 0,
  newUsers: 0,
  pinsByWeek: new Array<number>(PINS_BY_WEEK_WEEKS).fill(0),
}

/**
 * Run a section producer, returning its result or the fallback if it throws. The reason is reported via
 * `onError` so a failed card is observable (logged) without sinking the whole summary.
 */
export async function safeSection<T>(
  produce: () => Promise<T>,
  fallback: T,
  onError?: (err: unknown) => void,
): Promise<T> {
  try {
    return await produce()
  } catch (err) {
    if (onError) onError(err)
    return fallback
  }
}

export function toMapPin(record: HomeMapPinRecord): HomeMapPin {
  const base = {
    refType: record.refType,
    id: record.id,
    lat: record.lat,
    lng: record.lng,
    category: record.category,
    status: record.status as ReportStatus | EventStatus,
    flagged: record.flagged,
    title: record.title,
    place: record.place,
    // eventKind is meaningful only for event pins; null/omitted for report pins.
    ...(record.eventKind !== null ? { eventKind: record.eventKind } : {}),
  }
  return record.attendees !== null ? { ...base, attendees: record.attendees } : base
}

/** Default number of recent pins the live-map feed returns. */
export const HOME_MAP_PIN_LIMIT = 200

export interface HomeServiceDeps {
  repo: HomeRepository
  /** Reused for the analytics-mini block so the home digest matches the full analytics page. */
  analytics: AnalyticsRepository
  /** Injectable clock (defaults to Date.now) so the pins-spark window is deterministic. */
  now?: () => Date
  /** Optional error sink for a failed sub-aggregate (defaults to a no-op; the route can pass a logger). */
  onSectionError?: (section: string, err: unknown) => void
}

export interface HomeService {
  summary(): Promise<HomeSummaryResponse>
  map(): Promise<HomeMapResponse>
}

export function makeHomeService(deps: HomeServiceDeps): HomeService {
  const now = deps.now ?? (() => new Date())
  const report = (section: string) => (err: unknown) => deps.onSectionError?.(section, err)

  async function analyticsMini(): Promise<AnalyticsMini> {
    const ref = now()
    const [kpis, coverage, pinsByWeek] = await Promise.all([
      safeSection(() => deps.analytics.kpis(), null, report("analytics.kpis")),
      safeSection<AnalyticsCoverageResponse | null>(
        async () => buildCoverage(await deps.analytics.coverage()),
        null,
        report("analytics.coverage"),
      ),
      safeSection(
        async () =>
          buildPinsByWeek(
            await deps.analytics.pinsByWeek(PINS_BY_WEEK_WEEKS),
            PINS_BY_WEEK_WEEKS,
            ref,
          ).weeks,
        ZERO_ANALYTICS_MINI.pinsByWeek,
        report("analytics.pinsByWeek"),
      ),
    ])
    return {
      pinsThisMonth: kpis ? kpis.pins.current : 0,
      resolvedPct: kpis ? round1Pct(kpis.resolvedRatio.current) : 0,
      coveragePct: coverage ? coverage.pct : 0,
      cleanups: kpis ? kpis.cleanupsPlanned.current : 0,
      eventsThisMonth: kpis ? kpis.events.current : 0,
      newUsers: kpis ? kpis.newUsers.current : 0,
      pinsByWeek,
    }
  }

  return {
    async summary(): Promise<HomeSummaryResponse> {
      const [discovery, reports, events, mail, users, livePins24h, analytics] = await Promise.all([
        safeSection(() => deps.repo.discoverySummary(), ZERO_DISCOVERY, report("discovery")),
        safeSection(() => deps.repo.reportsSummary(), ZERO_REPORTS, report("reports")),
        safeSection(() => deps.repo.eventsSummary(), ZERO_EVENTS, report("events")),
        safeSection(() => deps.repo.mailSummary(), ZERO_MAIL, report("mail")),
        safeSection(() => deps.repo.usersSummary(), ZERO_USERS, report("users")),
        safeSection(() => deps.repo.livePins24h(), 0, report("livePins24h")),
        analyticsMini(),
      ])
      return { discovery, reports, events, mail, users, analytics, livePins24h }
    },

    async map(): Promise<HomeMapResponse> {
      const records = await deps.repo.recentPins(HOME_MAP_PIN_LIMIT)
      return { pins: records.map(toMapPin) }
    },
  }
}

/** Resolved ratio (0-1) -> percentage (0-100) with one decimal, reusing the analytics pct rounding. */
function round1Pct(ratio: number): number {
  return pct(ratio * 100, 100)
}
