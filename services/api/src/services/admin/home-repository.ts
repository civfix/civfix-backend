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
}

export interface UsersSectionCounts {
  flagged: number
  highRisk: number
  suspended: number
}

export interface HomeMapPinRecord {
  refType: "report" | "event"
  id: string
  lat: number
  lng: number
  category: ReportCategory | null
  status: string
  flagged: boolean
  title: string
  place: string
  attendees: number | null
  eventKind: EventKind | null
}

export interface HomeRepository {
  discoverySummary(): Promise<DiscoverySectionCounts>
  reportsSummary(): Promise<ReportsSectionCounts>
  eventsSummary(): Promise<EventsSectionCounts>
  mailSummary(): Promise<MailSectionCounts>
  usersSummary(): Promise<UsersSectionCounts>
  livePins24h(): Promise<number>
  moderationQueue(): Promise<number>
  inboxUnread(): Promise<number>
  recentPins(limit: number): Promise<HomeMapPinRecord[]>
}
