import type { BroadcastKind, CleanupStatus, RegistrationSource } from "@civfix/shared"
import type { DayCount, DayTimeCount, KeyCount } from "@civfix/shared/host"

export interface EventKpiRow {
  registered: number
  checkedIn: number
  waitlisted: number
  cancelled: number
  noShow: number
  capacity: number | null
}

export interface EventClockRecord {
  status: CleanupStatus
  createdAt: Date
  scheduledAt: Date
  endsAt: Date | null
  completedAt: Date | null
  registrationClosesAt: Date | null
  timezone: string | null
}

export interface SeatTrendPoint {
  day: string
  added: number
  removed: number
}

export interface SourceSeats {
  source: RegistrationSource
  seats: number
}

export interface EventBroadcastRecord {
  id: string
  kind: BroadcastKind
  finishedAt: Date | null
  recipients: number
  sent: number
  failed: number
  suppressed: number
}

export interface EventHoursTotals {
  credited: number
  attendeesCredited: number
  attendeesCheckedIn: number
}

export interface TopVolunteerRow {
  userId: string
  name: string
  handle: string | null
  avatarUrl: string | null
  hours: number
}

export interface PortfolioHoursTotals {
  credited: number
  volunteersCredited: number
}

export interface ReturningAttendees {
  seats: number
  ofRegistered: number
}

export interface PortfolioTotals {
  events: number
  registrations: number
  checkIns: number
  uniqueAttendees: number
  repeatAttendees: number
}

export interface HostActivityTotals {
  registrations: number
  cancellations: number
  hoursTotal: number
  hoursVolunteers: number
  reportsLinked: number
  reportsResolved: number
  postsCreated: number
}

export interface HeldEventTotals {
  events: number
  registered: number
  checkedIn: number
  noShow: number
}

export interface LabeledKeyCount extends KeyCount {
  label: string
}

export interface HostSummarySignups {
  daily: DayCount[]
  byEvent: LabeledKeyCount[]
  hoursByEvent: LabeledKeyCount[]
}

export interface AnalyticsRepository {
  eventKpis(cleanupId: string): Promise<EventKpiRow>
  registrationsByDay(
    cleanupId: string,
    timezone: string,
    from: string,
    to: string,
  ): Promise<DayCount[]>
  cancellationsByDay(
    cleanupId: string,
    timezone: string,
    from: string,
    to: string,
  ): Promise<DayCount[]>
  registrationsByTicketType(cleanupId: string): Promise<KeyCount[]>
  registrationsByAudience(cleanupId: string): Promise<KeyCount[]>
  checkinsByTicketType(cleanupId: string): Promise<KeyCount[]>
  checkinsBySlot(cleanupId: string): Promise<KeyCount[]>
  arrivalOffsets(cleanupId: string, limit: number): Promise<number[]>
  waitlistConversion(cleanupId: string): Promise<{ promoted: number; joined: number }>
  hostedEventIds(userId: string, organizationId: string | null, limit: number): Promise<string[]>
  portfolioTotals(cleanupIds: readonly string[]): Promise<PortfolioTotals>
  portfolioByEvent(cleanupIds: readonly string[], limit: number): Promise<KeyCount[]>
  portfolioDayTime(cleanupIds: readonly string[]): Promise<DayTimeCount[]>
  broadcastsSent(cleanupId: string, timezone: string, from: string, to: string): Promise<number>
  eventClock(cleanupId: string): Promise<EventClockRecord | null>
  seatTrend(cleanupId: string, timezone: string): Promise<SeatTrendPoint[]>
  registrationsBySource(cleanupId: string): Promise<SourceSeats[]>
  broadcastsForEvent(cleanupId: string, limit: number): Promise<EventBroadcastRecord[]>
  eventHoursTotals(cleanupId: string): Promise<EventHoursTotals>
  topVolunteers(cleanupIds: readonly string[], limit: number): Promise<TopVolunteerRow[]>
  hoursTotals(cleanupIds: readonly string[]): Promise<PortfolioHoursTotals>
  returningAttendees(
    cleanupId: string,
    hostedEventIds: readonly string[],
  ): Promise<ReturningAttendees>
  activityTotals(cleanupIds: readonly string[], from: Date, to: Date): Promise<HostActivityTotals>
  heldEventTotals(cleanupIds: readonly string[], from: Date, to: Date): Promise<HeldEventTotals>
  signupsByDayAcross(
    cleanupIds: readonly string[],
    fromDay: string,
    toDay: string,
  ): Promise<HostSummarySignups>
}
