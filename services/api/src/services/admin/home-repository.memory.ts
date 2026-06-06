/**
 * In-memory HomeRepository for the offline home-service unit tests (no DB, no Docker).
 *
 * Like the analytics memory repo, the home aggregates are the database's job, so this repo lets a test SET
 * the canned per-section counts + the recent-pin records each method returns. A method can also be made to
 * THROW (set its *Error field) so a test can prove the per-card resilience (a failing sub-aggregate
 * degrades only that card, never the whole summary).
 */

import type {
  DiscoverySectionCounts,
  EventsSectionCounts,
  HomeMapPinRecord,
  HomeRepository,
  MailSectionCounts,
  ReportsSectionCounts,
  UsersSectionCounts,
} from "./home-service.js"

export class InMemoryHomeRepository implements HomeRepository {
  discoveryValue: DiscoverySectionCounts = { queue: 0, reportsWaiting: 0, overSla: 0 }
  reportsValue: ReportsSectionCounts = { flagged: 0, inProgress: 0, completed: 0 }
  eventsValue: EventsSectionCounts = { upcoming: 0, live: 0, attending: 0 }
  mailValue: MailSectionCounts = { unread: 0, needsAction: 0, bounceRate: 0 }
  usersValue: UsersSectionCounts = { flagged: 0, highRisk: 0, suspended: 0 }
  livePinsValue = 0
  recentPinsValue: HomeMapPinRecord[] = []

  /** When set, the matching method rejects (to exercise per-card resilience). */
  discoveryError: Error | null = null
  reportsError: Error | null = null
  eventsError: Error | null = null
  mailError: Error | null = null
  usersError: Error | null = null
  livePinsError: Error | null = null

  async discoverySummary(): Promise<DiscoverySectionCounts> {
    if (this.discoveryError) throw this.discoveryError
    return this.discoveryValue
  }
  async reportsSummary(): Promise<ReportsSectionCounts> {
    if (this.reportsError) throw this.reportsError
    return this.reportsValue
  }
  async eventsSummary(): Promise<EventsSectionCounts> {
    if (this.eventsError) throw this.eventsError
    return this.eventsValue
  }
  async mailSummary(): Promise<MailSectionCounts> {
    if (this.mailError) throw this.mailError
    return this.mailValue
  }
  async usersSummary(): Promise<UsersSectionCounts> {
    if (this.usersError) throw this.usersError
    return this.usersValue
  }
  async livePins24h(): Promise<number> {
    if (this.livePinsError) throw this.livePinsError
    return this.livePinsValue
  }
  async recentPins(_limit: number): Promise<HomeMapPinRecord[]> {
    return this.recentPinsValue
  }
}
