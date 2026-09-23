import type {
  AnalyticsCoverageResponse,
  EventStatus,
  HomeMapPin,
  HomeMapResponse,
  HomeSummaryResponse,
  ReportStatus,
} from "@civfix/shared"
import type { AnalyticsRepository } from "./analytics-types.js"
import { buildCoverage, buildPinsByWeek, round1 } from "./analytics-shaping.js"
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
import { mapWithLimit } from "../../lib/concurrency.js"

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

// One failing section must not blank the whole operator home page; the failure reaches the log through
// onError.
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

const HOME_MAP_PIN_LIMIT = 200

export const HOME_SUMMARY_CONCURRENCY = 3

type SectionTasks = readonly (() => Promise<unknown>)[]

type SectionResults<T extends SectionTasks> = {
  -readonly [K in keyof T]: Awaited<ReturnType<T[K]>>
}

async function runBounded<T extends SectionTasks>(
  limit: number,
  tasks: T,
): Promise<SectionResults<T>> {
  return (await mapWithLimit(tasks, limit, (task) => task())) as SectionResults<T>
}

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

  function toAnalyticsMini(
    kpis: Awaited<ReturnType<AnalyticsRepository["kpis"]>> | null,
    coverage: AnalyticsCoverageResponse | null,
    pinsByWeek: number[],
  ): AnalyticsMini {
    return {
      pinsThisMonth: kpis ? kpis.pins.current : 0,
      resolvedPct: kpis ? round1(kpis.resolvedRatio.current * 100) : 0,
      coveragePct: coverage ? coverage.pct : 0,
      cleanups: kpis ? kpis.cleanupsPlanned.current : 0,
      eventsThisMonth: kpis ? kpis.events.current : 0,
      newUsers: kpis ? kpis.newUsers.current : 0,
      pinsByWeek,
    }
  }

  return {
    async summary(): Promise<HomeSummaryResponse> {
      const ref = now()
      const [
        discovery,
        reports,
        events,
        mail,
        users,
        livePins24h,
        kpis,
        coverage,
        pinsByWeek,
        moderationQueue,
        inboxUnread,
      ] = await runBounded(HOME_SUMMARY_CONCURRENCY, [
        () => safeSection(() => deps.repo.discoverySummary(), ZERO_DISCOVERY, report("discovery")),
        () => safeSection(() => deps.repo.reportsSummary(), ZERO_REPORTS, report("reports")),
        () => safeSection(() => deps.repo.eventsSummary(), ZERO_EVENTS, report("events")),
        () => safeSection(() => deps.repo.mailSummary(), ZERO_MAIL, report("mail")),
        () => safeSection(() => deps.repo.usersSummary(), ZERO_USERS, report("users")),
        () => safeSection(() => deps.repo.livePins24h(), 0, report("livePins24h")),
        () => safeSection(() => deps.analytics.kpis(), null, report("analytics.kpis")),
        () =>
          safeSection<AnalyticsCoverageResponse | null>(
            async () => buildCoverage(await deps.analytics.coverage()),
            null,
            report("analytics.coverage"),
          ),
        () =>
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
        () => safeSection(() => deps.repo.moderationQueue(), 0, report("moderationQueue")),
        () => safeSection(() => deps.repo.inboxUnread(), 0, report("inboxUnread")),
      ] as const)
      return {
        discovery,
        reports,
        events,
        mail,
        users,
        analytics: toAnalyticsMini(kpis, coverage, pinsByWeek),
        livePins24h,
        moderationQueue,
        inboxUnread,
      }
    },

    async map(): Promise<HomeMapResponse> {
      const records = await deps.repo.recentPins(HOME_MAP_PIN_LIMIT)
      return { pins: records.map(toMapPin) }
    },
  }
}
