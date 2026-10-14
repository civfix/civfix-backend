import type { KeyCount } from "@civfix/shared/host"

export interface EventAnalyticsFacts {
  walkUps: number
  reportsLinked: number
  reportsResolved: number
  postsCreated: number
}

export interface EventComparisonMedians {
  sampleSize: number
  signups: number | null
  checkInRate: number | null
  hoursPerVolunteer: number | null
  fillRate: number | null
}

export interface EventAnalyticsRepository {
  previousCompletedEventIds(args: {
    userId: string
    organizationId: string | null
    excludeCleanupId: string
    limit: number
  }): Promise<string[]>
  facts(cleanupId: string): Promise<EventAnalyticsFacts>
  registrationsBySlot(cleanupId: string): Promise<KeyCount[]>
  reportStatuses(cleanupId: string): Promise<KeyCount[]>
  hoursBuckets(cleanupId: string): Promise<KeyCount[]>
  comparisonMedians(cleanupIds: readonly string[]): Promise<EventComparisonMedians>
}
