import type { EventKind, ReportCategory } from "@civfix/shared"

export interface DiscoverySectionCounts {
  queue: number
  reportsWaiting: number
  overSla: number
}

export interface ReportsSectionCounts {
  flagged: number
  inProgress: number
  completed: number
}

export interface EventsSectionCounts {
  upcoming: number
  live: number
  attending: number
}

export interface MailSectionCounts {
  unread: number
  needsAction: number
  bounceRate: number
}

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
  /** For an event pin, which kind of event; null for report pins. */
  eventKind: EventKind | null
}

/**
 * Persistence seam for the home dashboard. The Drizzle impl runs the per-section count queries + the
 * recent-pins query; the offline tests pass an in-memory impl. Each method is independent so the service
 * can guard them individually (a failed card never sinks the summary).
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
