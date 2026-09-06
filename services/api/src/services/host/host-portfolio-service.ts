import type {
  HostedEventDTO,
  HostPortfolioKpis,
  ListMyHostedEventsResponse,
} from "@civfix/shared"
import { hostCapabilities, NO_HOST_STANDING, type HostStanding } from "@civfix/shared/host"
import type { EventMediaPresigner } from "./event-media.js"
import type {
  HostedEventRecord,
  HostPortfolioRepository,
} from "./host-portfolio-repository.drizzle.js"
import { ZERO_HOSTED_EVENT_COUNTS, type HostedEventCounts } from "./portfolio-counts.js"
import { isEventPubliclyVisible } from "./authz.js"
import { mapWithLimit, PRESIGN_CONCURRENCY } from "../media-presign.js"

export const HOSTED_EVENTS_DEFAULT_LIMIT = 20

export interface HostPortfolioCountsLoader {
  (cleanupIds: readonly string[]): Promise<Map<string, HostedEventCounts>>
}

export interface HostPortfolioServiceDeps {
  repo: HostPortfolioRepository
  counts: HostPortfolioCountsLoader
  presignEventMedia?: EventMediaPresigner
  now?: () => Date
}

export interface HostPortfolioService {
  listMyHostedEvents(
    userId: string,
    query: {
      when?: "upcoming" | "past" | "all"
      orgId?: string
      cursor?: string
      limit?: number
    },
  ): Promise<ListMyHostedEventsResponse>
}

function standingOf(record: HostedEventRecord): HostStanding {
  if (record.eventRole === null && record.orgRole === null) return NO_HOST_STANDING
  return { eventRole: record.eventRole, orgRole: record.orgRole }
}

export function makeHostPortfolioService(
  deps: HostPortfolioServiceDeps,
): HostPortfolioService {
  const now = deps.now ?? (() => new Date())

  return {
    async listMyHostedEvents(
      userId: string,
      query: {
        when?: "upcoming" | "past" | "all"
        orgId?: string
        cursor?: string
        limit?: number
      },
    ): Promise<ListMyHostedEventsResponse> {
      const limit = query.limit ?? HOSTED_EVENTS_DEFAULT_LIMIT
      const { items, nextCursor } = await deps.repo.listHostedEvents({
        userId,
        when: query.when ?? "upcoming",
        organizationId: query.orgId ?? null,
        cursor: query.cursor ?? null,
        limit,
      })
      const ids = items.map((r) => r.id)
      const [counts, kpiBase] = await Promise.all([deps.counts(ids), deps.repo.kpisFor(userId, now())])

      const presign = deps.presignEventMedia
      const coverUrls = await mapWithLimit(items, PRESIGN_CONCURRENCY, (record) =>
        record.coverKey === null || presign === undefined
          ? Promise.resolve(null)
          : presign(record.coverKey, {
              forceSigned: !isEventPubliclyVisible(record.visibility),
            }),
      )

      const dtos: HostedEventDTO[] = []
      let totalRegistrations = 0
      let totalCheckedIn = 0
      for (const [index, record] of items.entries()) {
        const standing = standingOf(record)
        const rowCounts = counts.get(record.id) ?? ZERO_HOSTED_EVENT_COUNTS
        totalRegistrations += rowCounts.registered
        totalCheckedIn += rowCounts.checkedIn
        const coverThumbUrl = coverUrls[index] ?? null
        dtos.push({
          id: record.id,
          referenceCode: record.referenceCode,
          title: record.title,
          startsAt: record.startsAt.toISOString(),
          endsAt: record.endsAt === null ? null : record.endsAt.toISOString(),
          timezone: record.timezone,
          status: record.status,
          visibility: record.visibility,
          coverThumbUrl,
          registeredCount: rowCounts.registered,
          capacity: record.capacity,
          checkedInCount: rowCounts.checkedIn,
          waitlistCount: rowCounts.waitlisted,
          myRole: record.eventRole,
          myCapabilities: [...hostCapabilities(standing)],
          orgId: record.orgId,
          orgName: record.orgName,
          pageSlug: record.pageSlug,
          pageStatus: null,
        })
      }

      const kpis: HostPortfolioKpis = {
        eventsHosted: kpiBase.eventsHosted,
        upcomingEvents: kpiBase.upcomingEvents,
        totalRegistrations,
        totalCheckedIn,
      }
      return { items: dtos, nextCursor, kpis }
    },
  }
}
