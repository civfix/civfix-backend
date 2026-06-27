
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
const ZERO_MAIL: MailSectionCounts = { unread: 0, needsAction: 0 }
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
    ...(record.eventKind !== null ? { eventKind: record.eventKind } : {}),
  }
  return record.attendees !== null ? { ...base, attendees: record.attendees } : base
}

export const HOME_MAP_PIN_LIMIT = 200

export interface HomeServiceDeps {
  repo: HomeRepository
  analytics: AnalyticsRepository
  now?: () => Date
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

function round1Pct(ratio: number): number {
  return pct(ratio * 100, 100)
}
