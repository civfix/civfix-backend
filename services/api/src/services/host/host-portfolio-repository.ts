import type {
  CleanupMemberRole,
  CleanupStatus,
  EventPageStatus,
  EventVisibility,
  OrganizationMemberRole,
} from "@civfix/shared"

export interface HostedEventRecord {
  id: string
  referenceCode: string | null
  title: string
  startsAt: Date
  endsAt: Date | null
  timezone: string | null
  status: CleanupStatus
  visibility: EventVisibility
  coverKey: string | null
  capacity: number | null
  eventRole: CleanupMemberRole | null
  orgRole: OrganizationMemberRole | null
  orgId: string | null
  orgName: string | null
  pageSlug: string | null
  pageStatus: EventPageStatus | null
}

export interface HostPortfolioKpiRecord {
  eventsHosted: number
  upcomingEvents: number
}

export interface ListHostedEventsArgs {
  userId: string
  when: "upcoming" | "past" | "all"
  organizationId: string | null
  cursor: string | null
  limit: number
}

export interface HostPortfolioKpisArgs {
  userId: string
  organizationId: string | null
  now: Date
}

export interface HostPortfolioRepository {
  listHostedEvents(
    args: ListHostedEventsArgs,
  ): Promise<{ items: HostedEventRecord[]; nextCursor: string | null }>
  kpisFor(args: HostPortfolioKpisArgs): Promise<HostPortfolioKpiRecord>
}
