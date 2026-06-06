/**
 * Admin home / dashboard service (Phase 2): the dashboard aggregate (#4) + the live-map feed (#5),
 * enumeration 2.A.6 / 2.A.2.
 *
 * adminHomeSummary returns the per-section counts/leads the hub needs (so the home page does not fetch all
 * six section lists): discovery (queue + reports waiting + over-SLA), reports (flagged / in progress /
 * completed), events (upcoming / live / attending), mail (unread / needs-action / bounce rate), users
 * (flagged / high-risk / suspended), an analytics MINI block (pins this month, resolved %, coverage %,
 * cleanups, events this month, volunteers, the 8-week pins spark), and live pins 24h.
 *
 * RESILIENCE (enumeration 2.A.6: "each card can fail independently"): every section is computed inside its
 * own guard (safeSection). A failing sub-aggregate degrades ONLY that section to a neutral zero block; it
 * never 500s the whole summary. The analytics mini reuses the AnalyticsRepository (so the home digest and
 * the full analytics page agree); each of its inputs is likewise guarded.
 *
 * adminHomeMap returns recent reports + events as pins (refType/id/lat/lng/category/status/flagged/title/
 * place/attendees) for the LiveMap present in every home layout.
 */

import type {
  AnalyticsCoverageResponse,
  EventStatus,
  HomeMapPin,
  HomeMapResponse,
  HomeSummaryResponse,
  ReportCategory,
  ReportStatus,
} from "@civfix/shared"
import type { AnalyticsRepository } from "./analytics-service.js"
import { buildCoverage, buildPinsByWeek, pct, PINS_BY_WEEK_WEEKS } from "./analytics-service.js"

// ---------------------------------------------------------------------------
// Repository raw-section shapes
// ---------------------------------------------------------------------------

/** Discovery summary counts (queue size + total reports waiting + over-SLA count). */
export interface DiscoverySectionCounts {
  queue: number
  reportsWaiting: number
  overSla: number
}

/** Reports summary counts (flagged + in-progress + completed/resolved). */
export interface ReportsSectionCounts {
  flagged: number
  inProgress: number
  completed: number
}

/** Events summary counts (upcoming + live + attending across non-completed events). */
export interface EventsSectionCounts {
  upcoming: number
  live: number
  attending: number
}

/** Mail summary counts (unread + needs-action + the rolling bounce rate). */
export interface MailSectionCounts {
  unread: number
  needsAction: number
  bounceRate: number
}

/** Users summary counts (flagged + high-risk + suspended/banned). */
export interface UsersSectionCounts {
  flagged: number
  highRisk: number
  suspended: number
}

/** A raw map pin record (a recent report or event) the repo returns; the service projects it to the DTO. */
export interface HomeMapPinRecord {
  refType: "report" | "event"
  id: string
  lat: number
  lng: number
  category: ReportCategory | null
  /** A report status OR an event status (already reconciled to the wire enums by the repo). */
  status: string
  flagged: boolean
  title: string
  place: string
  attendees: number | null
}

/**
 * Persistence seam for the home dashboard. The Drizzle impl runs the per-section count queries + the
 * recent-pins query; the offline tests pass an in-memory impl. Each method is independent so the service
 * can guard them individually.
 */
export interface HomeRepository {
  discoverySummary(): Promise<DiscoverySectionCounts>
  reportsSummary(): Promise<ReportsSectionCounts>
  eventsSummary(): Promise<EventsSectionCounts>
  mailSummary(): Promise<MailSectionCounts>
  usersSummary(): Promise<UsersSectionCounts>
  livePins24h(): Promise<number>
  recentPins(limit: number): Promise<HomeMapPinRecord[]>
}

// ---------------------------------------------------------------------------
// Neutral fallbacks (used when a sub-aggregate fails)
// ---------------------------------------------------------------------------

const ZERO_DISCOVERY: DiscoverySectionCounts = { queue: 0, reportsWaiting: 0, overSla: 0 }
const ZERO_REPORTS: ReportsSectionCounts = { flagged: 0, inProgress: 0, completed: 0 }
const ZERO_EVENTS: EventsSectionCounts = { upcoming: 0, live: 0, attending: 0 }
const ZERO_MAIL: MailSectionCounts = { unread: 0, needsAction: 0, bounceRate: 0 }
const ZERO_USERS: UsersSectionCounts = { flagged: 0, highRisk: 0, suspended: 0 }

/** The analytics-mini block the home tile renders. */
interface AnalyticsMini {
  pinsThisMonth: number
  resolvedPct: number
  coveragePct: number
  cleanups: number
  eventsThisMonth: number
  volunteers: number
  pinsByWeek: number[]
}

const ZERO_ANALYTICS_MINI: AnalyticsMini = {
  pinsThisMonth: 0,
  resolvedPct: 0,
  coveragePct: 0,
  cleanups: 0,
  eventsThisMonth: 0,
  volunteers: 0,
  pinsByWeek: new Array<number>(PINS_BY_WEEK_WEEKS).fill(0),
}

// ---------------------------------------------------------------------------
// Resilience helper
// ---------------------------------------------------------------------------

/**
 * Run a section producer, returning its result or the fallback if it throws. The reason is reported via
 * `onError` so a failed card is observable (logged) without sinking the whole summary. Pure aside from the
 * injected producer + logger.
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

/** Map the wire map-pin record to the strict HomeMapPin DTO (attendees omitted when null). */
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
  }
  return record.attendees !== null ? { ...base, attendees: record.attendees } : base
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

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

  /** Compute the analytics-mini block, each input independently guarded. */
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
      volunteers: kpis ? kpis.volunteers.current : 0,
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
