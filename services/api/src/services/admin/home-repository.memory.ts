import type {
  DiscoverySectionCounts,
  EventsSectionCounts,
  HomeMapPinRecord,
  HomeRepository,
  MailSectionCounts,
  ReportsSectionCounts,
  UsersSectionCounts,
} from "./home-types.js"

export class InMemoryHomeRepository implements HomeRepository {
  discoveryValue: DiscoverySectionCounts = { queue: 0, reportsWaiting: 0, overSla: 0 }
  reportsValue: ReportsSectionCounts = { flagged: 0, inProgress: 0, completed: 0 }
  eventsValue: EventsSectionCounts = { upcoming: 0, live: 0, attending: 0 }
  mailValue: MailSectionCounts = { unread: 0, needsAction: 0 }
  usersValue: UsersSectionCounts = { flagged: 0, highRisk: 0, suspended: 0 }
  livePinsValue = 0
  moderationQueueValue = 0
  inboxUnreadValue = 0
  recentPinsValue: HomeMapPinRecord[] = []

  discoveryError: Error | null = null
  reportsError: Error | null = null
  eventsError: Error | null = null
  mailError: Error | null = null
  usersError: Error | null = null
  livePinsError: Error | null = null
  moderationQueueError: Error | null = null
  inboxUnreadError: Error | null = null

  async discoverySummary(): Promise<DiscoverySectionCounts> {
    if (this.discoveryError) throw this.discoveryError
    return { ...this.discoveryValue }
  }
  async reportsSummary(): Promise<ReportsSectionCounts> {
    if (this.reportsError) throw this.reportsError
    return { ...this.reportsValue }
  }
  async eventsSummary(): Promise<EventsSectionCounts> {
    if (this.eventsError) throw this.eventsError
    return { ...this.eventsValue }
  }
  async mailSummary(): Promise<MailSectionCounts> {
    if (this.mailError) throw this.mailError
    return { ...this.mailValue }
  }
  async usersSummary(): Promise<UsersSectionCounts> {
    if (this.usersError) throw this.usersError
    return { ...this.usersValue }
  }
  async livePins24h(): Promise<number> {
    if (this.livePinsError) throw this.livePinsError
    return this.livePinsValue
  }
  async moderationQueue(): Promise<number> {
    if (this.moderationQueueError) throw this.moderationQueueError
    return this.moderationQueueValue
  }
  async inboxUnread(): Promise<number> {
    if (this.inboxUnreadError) throw this.inboxUnreadError
    return this.inboxUnreadValue
  }
  async recentPins(_limit: number): Promise<HomeMapPinRecord[]> {
    return [...this.recentPinsValue]
  }
}
