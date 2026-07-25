import { AppError, MAX_EVENT_HOURS } from "@civfix/shared"
import type {
  CleanupMemberRole,
  CleanupStatus,
  EventHoursEntry,
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

/**
 * L23 — `entries` is an unbounded array in the frozen shared wire schema (no `.max()`), capped only by
 * the 256 KB body limit, which admits roughly 6000 entries in one request. Every entry becomes a row in
 * a single advisory-locked transaction, so the array length is a direct lever on how long that lock is
 * held. Clamped here exactly as cleanup-service's clampLinkIds / MAX_LINKED_REPORTS clamps its arrays.
 * The cap is the member cap, because an entry that is not a current member is rejected anyway.
 * FOLLOW-UP: the real fix is `.max()` on LogEventHoursRequestSchema in @civfix/shared, which this repo
 * cannot edit.
 */
export const MAX_EVENT_HOURS_ENTRIES = EVENT_HOURS_MEMBER_CAP

// WS5 per-attendee shape: one {userId, hours} entry per credited attendee, upserted per row on the
// (cleanup_id, user_id) WHERE source='event' partial-unique index. `actorId` is the logging host
// (organizer or cohost) recorded as logged_by_user_id.
export interface LogEventHoursArgs {
  actorId: string
  cleanupId: string
  geoid: string | null
  entries: EventHoursEntry[]
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
  // The acting user's cleanup_members role (null = not a member). Gates WS5/D4 logging: the ACTOR must
  // be organizer or cohost (and themselves verified) to credit hours.
  roleOf(cleanupId: string, userId: string): Promise<CleanupMemberRole | null>
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
    actorId: string
    entries: EventHoursEntry[]
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
      actorId: string
      entries: EventHoursEntry[]
    }): Promise<LogEventHoursResponse> {
      const cleanup = await deps.cleanups.load(input.cleanupId)
      if (cleanup === null) throw AppError.notFound("Event not found")

      // WS4/WS5: organizer OR cohost may log hours (was organizer-only).
      const actorRole = await deps.cleanups.roleOf(input.cleanupId, input.actorId)
      if (actorRole !== "organizer" && actorRole !== "cohost") {
        throw AppError.forbidden("Only the event hosts can log volunteer hours.")
      }
      // D4: the ACTING user must THEMSELVES be a verified community organizer (this deliberately
      // replaced the old check on the ORGANIZER's verification — a verified cohost can log hours even
      // for an unverified organizer's event, and an unverified cohost cannot piggyback on a verified
      // organizer).
      const verified = await deps.isVerified(input.actorId)
      if (!verified) {
        throw AppError.forbidden("Only verified hosts can log volunteer hours.")
      }
      if (cleanup.status !== "done") {
        throw AppError.conflict("Volunteer hours can only be logged for a completed event.")
      }

      // Per-entry validation (the shared schema already enforces shape/bounds; re-checked here so the
      // service is safe under direct construction): hours in (0, MAX_EVENT_HOURS], no duplicate
      // userIds (a duplicate would also break the single-statement per-row upsert), and every entry
      // must be a CURRENT member of the cleanup.
      // L23: bound the unbounded shared array before doing any per-entry work.
      if (input.entries.length > MAX_EVENT_HOURS_ENTRIES) {
        throw AppError.validation({
          entries: `at most ${MAX_EVENT_HOURS_ENTRIES} attendees may be credited in one request`,
        })
      }

      const seen = new Set<string>()
      for (const entry of input.entries) {
        // M21: a host cannot credit THEMSELVES. Nothing excluded the actor before, and the organizer is
        // auto-inserted as a member at create time, so they always passed the membership filter below —
        // a verified host could mint unlimited public-leaderboard hours for their own account with no
        // second party involved anywhere in the flow. Crediting the organizer is still possible, but it
        // now requires a DIFFERENT host (a co-host) or an operator to do it, which is the whole point:
        // someone else has to attest to the hours.
        if (entry.userId === input.actorId) {
          throw AppError.forbidden(
            "You can't log volunteer hours for yourself — another host must credit you.",
          )
        }
        if (!(entry.hours > 0) || entry.hours > MAX_EVENT_HOURS) {
          throw AppError.validation({
            entries: `hours must be greater than 0 and at most ${MAX_EVENT_HOURS}`,
          })
        }
        if (seen.has(entry.userId)) {
          throw AppError.validation({ entries: `duplicate userId: ${entry.userId}` })
        }
        seen.add(entry.userId)
      }
      const memberIds = new Set(
        await deps.cleanups.listMemberIds(input.cleanupId, EVENT_HOURS_MEMBER_CAP),
      )
      const nonMembers = input.entries.filter((e) => !memberIds.has(e.userId))
      if (nonMembers.length > 0) {
        throw AppError.validation({
          entries: `not attending this event: ${nonMembers.map((e) => e.userId).join(", ")}`,
        })
      }

      const credited = await deps.repo.logEventHours({
        actorId: input.actorId,
        cleanupId: input.cleanupId,
        geoid: cleanup.jurisdictionGeoid,
        entries: input.entries,
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
