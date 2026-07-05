import { AppError } from "@civfix/shared"
import type {
  CleanupStatus,
  LeaderboardEntryDTO,
  LeaderboardQuery,
  LeaderboardResponse,
  LogEventHoursResponse,
  MyVolunteerHoursDTO,
} from "@civfix/shared"

export const LEADERBOARD_DEFAULT_LIMIT = 20
export const LEADERBOARD_MAX_LIMIT = 50
export const LEADERBOARD_MAX_OFFSET = 500
export const EVENT_HOURS_MEMBER_CAP = 2000

export interface LogEventHoursArgs {
  hostId: string
  cleanupId: string
  geoid: string | null
  attendeeIds: string[]
  hours: number
}

export interface LeaderboardPage {
  jurisdictionName: string | null
  entries: LeaderboardEntryDTO[]
  nextOffset: number | null
}

export interface VolunteerHoursRepository {
  awardReportHours(userId: string, reportId: string, geoid: string | null): Promise<void>
  logEventHours(args: LogEventHoursArgs): Promise<number>
  totalsFor(userId: string): Promise<MyVolunteerHoursDTO>
  totalHoursFor(userId: string): Promise<number>
  leaderboard(geoid: string, limit: number, offset: number): Promise<LeaderboardPage>
}

export interface CleanupHoursView {
  organizerUserId: string
  status: CleanupStatus
  jurisdictionGeoid: string | null
}

export interface CleanupHoursLookup {
  load(cleanupId: string): Promise<CleanupHoursView | null>
  listMemberIds(cleanupId: string, limit: number): Promise<string[]>
}

export interface VolunteerHoursServiceDeps {
  repo: VolunteerHoursRepository
  cleanups: CleanupHoursLookup
  isVerified: (userId: string) => Promise<boolean>
  logger?: { warn(obj: unknown, msg?: string): void }
}

export interface VolunteerHoursService {
  getMyHours(userId: string): Promise<MyVolunteerHoursDTO>
  logEventHours(input: {
    cleanupId: string
    hostId: string
    hours: number
  }): Promise<LogEventHoursResponse>
  leaderboard(geoid: string, query: LeaderboardQuery): Promise<LeaderboardResponse>
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return LEADERBOARD_DEFAULT_LIMIT
  return Math.min(Math.max(1, Math.floor(limit)), LEADERBOARD_MAX_LIMIT)
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return 0
  return Math.min(Math.max(0, Math.floor(offset)), LEADERBOARD_MAX_OFFSET)
}

export function makeVolunteerHoursService(deps: VolunteerHoursServiceDeps): VolunteerHoursService {
  return {
    getMyHours(userId: string): Promise<MyVolunteerHoursDTO> {
      return deps.repo.totalsFor(userId)
    },

    async logEventHours(input: {
      cleanupId: string
      hostId: string
      hours: number
    }): Promise<LogEventHoursResponse> {
      const cleanup = await deps.cleanups.load(input.cleanupId)
      if (cleanup === null) throw AppError.notFound("Event not found")

      if (cleanup.organizerUserId !== input.hostId) {
        throw AppError.forbidden("Only the event host can log volunteer hours.")
      }
      const verified = await deps.isVerified(input.hostId)
      if (!verified) {
        throw AppError.forbidden("Only verified hosts can log volunteer hours.")
      }
      if (cleanup.status !== "done") {
        throw AppError.conflict("Volunteer hours can only be logged for a completed event.")
      }

      const attendeeIds = await deps.cleanups.listMemberIds(input.cleanupId, EVENT_HOURS_MEMBER_CAP)
      const credited = await deps.repo.logEventHours({
        hostId: input.hostId,
        cleanupId: input.cleanupId,
        geoid: cleanup.jurisdictionGeoid,
        attendeeIds,
        hours: input.hours,
      })
      return { credited }
    },

    async leaderboard(geoid: string, query: LeaderboardQuery): Promise<LeaderboardResponse> {
      const limit = clampLimit(query.limit)
      const offset = clampOffset(query.offset)
      const page = await deps.repo.leaderboard(geoid, limit, offset)
      return {
        geoid,
        jurisdictionName: page.jurisdictionName,
        entries: page.entries,
        nextOffset: page.nextOffset,
      }
    },
  }
}
