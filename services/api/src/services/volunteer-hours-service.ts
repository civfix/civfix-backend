import { AppError, MAX_EVENT_HOURS, MAX_EVENT_HOURS_ENTRIES } from "@civfix/shared"
import type {
  CleanupMemberRole,
  CleanupStatus,
  EventHoursEntry,
  EventHoursResponse,
  LeaderboardEntryDTO,
  LeaderboardQuery,
  LeaderboardResponse,
  LogEventHoursResponse,
  MyVolunteerHoursDTO,
  MyVolunteerHoursEntriesQuery,
  MyVolunteerHoursEntriesResponse,
  PublicVolunteerHoursQuery,
  PublicVolunteerHoursResponse,
  VolunteerHoursEntryDTO,
  VolunteerHoursSource,
} from "@civfix/shared"
import { parseTimeCursor, type TimeCursor } from "../db/cursor-helpers.js"
import { mapWithLimit } from "./media-presign.js"
import type { NotificationService } from "./notification-service.js"

export const LEADERBOARD_DEFAULT_LIMIT = 20
export const LEADERBOARD_MAX_LIMIT = 50
export const LEADERBOARD_MAX_OFFSET = 500
export const EVENT_HOURS_MEMBER_CAP = 2000

/**
 * L23 (CLOSED) — `entries` used to be an unbounded array in the shared wire schema, so this file carried
 * its own cap. `LogEventHoursRequestSchema` now declares `.max(MAX_EVENT_HOURS_ENTRIES)` in
 * @civfix/shared, so the cap has exactly ONE source of truth and this module re-exports it rather than
 * re-declaring it (a second `export const` here would make importing the shared name a duplicate
 * identifier). The service still re-checks it below so it stays safe under direct construction.
 */
export { MAX_EVENT_HOURS_ENTRIES } from "@civfix/shared"

/**
 * Paging bounds for the itemised ledger reads (`/me/volunteer-hours/entries`,
 * `/people/:id/volunteer-hours`). The shared query schemas already cap `limit` at 50; these clamp a
 * directly-constructed service call the same way `clampLimit` does for the leaderboard.
 */
export const HOURS_ENTRIES_DEFAULT_LIMIT = 20
export const HOURS_ENTRIES_MAX_LIMIT = 50

/**
 * The leaderboard's `viewerRank` / `viewerHours` / `participantCount` cost two extra queries, and the
 * Discovery preview asks for `limit: 3` and renders none of them. Gate the extra work on the request
 * actually wanting it so the hot anon preview stays a single indexed read (and can keep the shared
 * `public, max-age=60` cache branch). The full board pages at 50; anything below this threshold is a
 * preview.
 *
 * *** COMPARE THE REQUEST'S `limit`, NEVER THE CLAMPED ONE. *** `LeaderboardQuerySchema.limit` is
 * `.optional()` with no default, so the shipped clients send NO limit at all for the full board;
 * `clampLimit(undefined)` then returns LEADERBOARD_DEFAULT_LIMIT (20), which is BELOW this threshold.
 * Testing the clamped value therefore turned the extras off for exactly the request that wants them —
 * the full board — and left them on only for a hand-written `?limit=25`. An ABSENT limit means "the full
 * board", so it opts IN; only an explicitly small preview limit opts out.
 */
export const LEADERBOARD_EXTRAS_MIN_LIMIT = 25

/** Fan-out concurrency for the hours_logged bell. Mirrors cleanup-service's cancellation fan-out. */
export const HOURS_NOTIFY_CONCURRENCY = 8

// WS5 per-attendee shape: one {userId, hours} entry per credited attendee, upserted per row on the
// (cleanup_id, user_id) WHERE source='event' partial-unique index. `actorId` is the logging host
// (organizer or cohost) recorded as logged_by_user_id.
export interface LogEventHoursArgs {
  actorId: string
  cleanupId: string
  geoid: string | null
  entries: EventHoursEntry[]
}

/**
 * B33b — the repo threads the audit INSERT's pre-image back out so the service can ring the bell ONLY for
 * a credit that is new or has increased. `previousHours === null` means no prior credit existed, which is
 * deliberately distinct from a stored 0 (the same distinction volunteer_hours_audit.previous_hours makes).
 */
export interface LogEventHoursResult {
  /** Distinct attendees credited — unchanged semantics, this is the wire `credited`. */
  credited: number
  changed: { userId: string; hours: number; previousHours: number | null }[]
}

/** One ledger row, joined out to everything the transcript DTO prints. */
export interface VolunteerHoursEntryView {
  id: string
  source: VolunteerHoursSource
  hours: number
  /** When the credit was written. Drives the keyset cursor. */
  createdAt: Date
  /** When the service happened: the event's scheduledAt, falling back to createdAt. */
  occurredAt: Date
  cleanupId: string | null
  cleanupTitle: string | null
  cleanupReferenceCode: string | null
  reportId: string | null
  jurisdictionGeoid: string | null
  jurisdictionName: string | null
  creditedBy: { id: string; name: string; handle: string | null; verified: boolean } | null
}

/** A row of the per-EVENT hours read-back (C10). */
export interface EventHoursLedgerEntry {
  userId: string
  hours: number
  loggedAt: Date
}

export interface EventHoursLedger {
  entries: EventHoursLedgerEntry[]
  /**
   * Whether the host has logged ANY hours for this event, independent of the filter applied to
   * `entries`. This is the whole reason the attendee receipt can say "not credited" instead of sitting
   * on "the host hasn't logged yet" forever (C10 / WP09 hoursReceiptState).
   */
  anyLogged: boolean
}

/**
 * C18 — the tri-state privacy column has TWO predicates, not one, and they gate different things:
 *   - `aggregate` = `show_volunteer_hours IS NOT FALSE AND deleted_at IS NULL` — governs `visible`,
 *     `totalHours`, `byJurisdiction` and `reportHours`. NULL (never chosen) stays visible, which is
 *     byte-identical to today's `volunteerHours` scalar.
 *   - `items` = `show_volunteer_hours IS TRUE` — governs `items[]` alone. Publishing where a named person
 *     physically was, on which dates, requires an explicit opt-in.
 * Both come from ONE row read, because both read the same column on the same user.
 */
export interface HoursVisibility {
  aggregate: boolean
  items: boolean
}

export interface LeaderboardPage {
  jurisdictionName: string | null
  entries: LeaderboardEntryDTO[]
  nextOffset: number | null
  /** DB B48: computed on the FIRST page only (offset 0) and only when extras were requested. */
  participantCount: number | null
  /** Null when the viewer has no hours here (or is anonymous / extras were not requested). */
  viewerRank: number | null
  viewerHours: number | null
}

/**
 * The sources an itemised ledger read may return when the caller does not filter — i.e. the OWNER's own
 * transcript. Deliberately NOT every source: `'report'` is excluded because filing a report is not
 * volunteer service and never was, so a historical `source='report'` row (all of which 0065 voided) must
 * not re-enter a service total or a transcript line even if one survives the void. Both repository impls
 * default `listEntries` to this, so the twin and the real thing cannot drift.
 */
export const ITEMISED_SOURCES: readonly VolunteerHoursSource[] = ["event", "manual"]

export interface ListEntriesArgs {
  userId: string
  cursor: TimeCursor | null
  limit: number
  /** The public projection passes ["event"]; omitted means ITEMISED_SOURCES (never 'report'). */
  sources?: VolunteerHoursSource[]
}

/**
 * The certificate read (DP §4.3 / WP21): the same ledger, filtered and ordered for printing rather than
 * paged. Lives on this repo because it reads `volunteer_hours`; the certificate repo owns only the
 * certificate rows themselves.
 */
export interface EntriesForCertificateArgs {
  userId: string
  geoid: string | null
  from: Date | null
  to: Date | null
  limit: number
}

export interface CertificateEntriesPage {
  items: VolunteerHoursEntryView[]
  /** Sum of the RETURNED rows (B40b: a printed total must equal the sum of the printed lines). */
  totalHours: number
  /** The full matching count, even when `items` was truncated at `limit`. */
  entryCount: number
}

export interface VolunteerHoursRepository {
  /**
   * `logEventHours` is the ONLY writer of credited hours. There is no `awardReportHours`: report filings
   * were credited 0.1h each until 2026-07-28, which put them on the public leaderboard and on signed PDF
   * transcripts. The capability was removed from the interface (not just unwired) so it cannot come back
   * through a dep seam; the historical rows are voided by drizzle/0065_void_report_volunteer_hours.sql.
   */
  logEventHours(args: LogEventHoursArgs): Promise<LogEventHoursResult>
  totalsFor(userId: string): Promise<MyVolunteerHoursDTO>
  totalHoursFor(userId: string): Promise<number>
  /**
   * `withExtras` gates the two supplementary queries (viewer standing + participant count). `viewerId`
   * null means anonymous, in which case there is no viewer standing to compute at all.
   */
  leaderboard(
    geoid: string,
    limit: number,
    offset: number,
    viewerId: string | null,
    withExtras: boolean,
  ): Promise<LeaderboardPage>
  listEntries(
    args: ListEntriesArgs,
  ): Promise<{ items: VolunteerHoursEntryView[]; nextCursor: string | null }>
  /** `viewerId` null = no per-user filter (the acting-host `scope: "all"` read). */
  listEventHours(cleanupId: string, viewerId: string | null): Promise<EventHoursLedger>
  hoursVisibilityFor(userId: string): Promise<HoursVisibility>
  entriesForCertificate(args: EntriesForCertificateArgs): Promise<CertificateEntriesPage>
}

export interface CleanupHoursView {
  organizerUserId: string
  status: CleanupStatus
  jurisdictionGeoid: string | null
  /** Needed by the hours_logged bell body ("{{hours}} hours were credited for {{title}}."). */
  title: string
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
  isBlockedEitherWay?: (viewerId: string, targetId: string) => Promise<boolean>
  /** Optional so an offline test can run without the notification pipeline — no notifier means no bells. */
  notifier?: Pick<NotificationService, "createNotification">
  logger?: { warn(obj: unknown, msg?: string): void }
}

export interface VolunteerHoursService {
  getMyHours(userId: string): Promise<MyVolunteerHoursDTO>
  getMyHoursEntries(
    userId: string,
    query: MyVolunteerHoursEntriesQuery,
  ): Promise<MyVolunteerHoursEntriesResponse>
  getPublicHours(
    query: PublicVolunteerHoursQuery,
    viewerId: string | null,
  ): Promise<PublicVolunteerHoursResponse>
  getEventHours(cleanupId: string, viewerId: string): Promise<EventHoursResponse>
  logEventHours(input: {
    cleanupId: string
    actorId: string
    entries: EventHoursEntry[]
  }): Promise<LogEventHoursResponse>
  leaderboard(
    geoid: string,
    query: LeaderboardQuery,
    viewerId?: string | null,
  ): Promise<LeaderboardResponse>
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return LEADERBOARD_DEFAULT_LIMIT
  return Math.min(Math.max(1, Math.floor(limit)), LEADERBOARD_MAX_LIMIT)
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return 0
  return Math.min(Math.max(0, Math.floor(offset)), LEADERBOARD_MAX_OFFSET)
}

function clampEntriesLimit(limit: number | undefined): number {
  if (limit === undefined) return HOURS_ENTRIES_DEFAULT_LIMIT
  return Math.min(Math.max(1, Math.floor(limit)), HOURS_ENTRIES_MAX_LIMIT)
}

function neutralPublicHours(): PublicVolunteerHoursResponse {
  return {
    visible: true,
    totalHours: 0,
    byJurisdiction: [],
    items: [],
    reportHours: 0,
    nextCursor: null,
  }
}

/** Round to the same 2 decimals the numeric(6,2) ledger column stores, killing float8 read noise. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * A ledger row on the wire. Every join-derived field is nullable in the view and `.optional()` on the
 * DTO, so a null is OMITTED rather than sent as `null` — the same "absent means we have nothing" idiom
 * the cleanup and report DTOs use.
 */
export function toVolunteerHoursEntryDTO(view: VolunteerHoursEntryView): VolunteerHoursEntryDTO {
  return {
    id: view.id,
    source: view.source,
    hours: round2(view.hours),
    occurredAt: view.occurredAt.toISOString(),
    creditedAt: view.createdAt.toISOString(),
    ...(view.cleanupId !== null ? { eventId: view.cleanupId } : {}),
    ...(view.cleanupTitle !== null ? { eventTitle: view.cleanupTitle } : {}),
    ...(view.cleanupReferenceCode !== null
      ? { eventReferenceCode: view.cleanupReferenceCode }
      : {}),
    ...(view.reportId !== null ? { reportId: view.reportId } : {}),
    ...(view.jurisdictionGeoid !== null ? { jurisdictionGeoid: view.jurisdictionGeoid } : {}),
    ...(view.jurisdictionName !== null ? { jurisdictionName: view.jurisdictionName } : {}),
    ...(view.creditedBy !== null
      ? {
          creditedBy: {
            id: view.creditedBy.id,
            name: view.creditedBy.name,
            ...(view.creditedBy.handle !== null ? { handle: view.creditedBy.handle } : {}),
            verified: view.creditedBy.verified,
          },
        }
      : {}),
  }
}

function toEventHoursRow(entry: EventHoursLedgerEntry): {
  userId: string
  hours: number
  loggedAt: string
} {
  return {
    userId: entry.userId,
    hours: round2(entry.hours),
    loggedAt: entry.loggedAt.toISOString(),
  }
}

export function makeVolunteerHoursService(deps: VolunteerHoursServiceDeps): VolunteerHoursService {
  /**
   * B33 — the hours-credited receipt. Fired AFTER the repo write, best-effort, and best-effort PER
   * RECIPIENT (`mapWithLimit(recipients, 8, …)`), which is the exact shape of cleanup-service's
   * `notifyCancellation`: one try/catch around the whole loop would let a single bad prefs row abandon
   * every remaining attendee silently.
   *
   * B33b — only a NEW or INCREASED credit rings. Re-logging is how a host corrects a typo, and the upsert
   * re-writes every row in the batch, so notifying on every write would ring up to 2000 lock screens per
   * correction: the bell-bombing class M18's role-flip cooldown exists to prevent. A DOWNWARD correction
   * is deliberately silent — it is visible in the ledger, and a "your hours were reduced" push invites a
   * conflict the app has no channel to resolve.
   */
  async function notifyHoursLogged(
    cleanup: { id: string; title: string },
    changed: LogEventHoursResult["changed"],
    actorId: string,
  ): Promise<void> {
    const notifier = deps.notifier
    if (notifier === undefined) return
    const recipients = changed.filter(
      (c) =>
        c.userId !== actorId && (c.previousHours === null || c.hours > c.previousHours),
    )
    await mapWithLimit(recipients, HOURS_NOTIFY_CONCURRENCY, async (c) => {
      try {
        await notifier.createNotification(c.userId, {
          type: "hours_logged",
          titleKey: "notification.hours_logged.title",
          bodyKey: "notification.hours_logged.body",
          vars: { hours: round2(c.hours), title: cleanup.title },
          link: `/cleanups/${cleanup.id}`,
        })
      } catch (err) {
        deps.logger?.warn(
          { err, cleanupId: cleanup.id, userId: c.userId },
          "hours_logged notification failed (suppressed)",
        )
      }
    })
  }

  return {
    getMyHours(userId: string): Promise<MyVolunteerHoursDTO> {
      return deps.repo.totalsFor(userId)
    },

    /**
     * B30a — the owner's own itemised transcript. Itemises EVERY source (it is their own data), and
     * `totalHours` comes from the `totalHoursFor` ROLLUP rather than the page, so the header total does
     * not change as the reader scrolls.
     */
    async getMyHoursEntries(
      userId: string,
      query: MyVolunteerHoursEntriesQuery,
    ): Promise<MyVolunteerHoursEntriesResponse> {
      const limit = clampEntriesLimit(query.limit)
      const [page, totalHours] = await Promise.all([
        deps.repo.listEntries({ userId, cursor: parseTimeCursor(query.cursor), limit }),
        deps.repo.totalHoursFor(userId),
      ])
      return {
        items: page.items.map(toVolunteerHoursEntryDTO),
        nextCursor: page.nextCursor,
        totalHours,
      }
    },

    async getPublicHours(
      query: PublicVolunteerHoursQuery,
      viewerId: string | null,
    ): Promise<PublicVolunteerHoursResponse> {
      const userId = query.id
      const isSelf = viewerId !== null && viewerId === userId

      const [blockedEitherWay, visibility] = await Promise.all([
        !isSelf && viewerId !== null && deps.isBlockedEitherWay
          ? deps.isBlockedEitherWay(viewerId, userId)
          : Promise.resolve(false),
        isSelf
          ? Promise.resolve({ aggregate: true, items: true })
          : deps.repo.hoursVisibilityFor(userId),
      ])

      if (blockedEitherWay || !visibility.aggregate) {
        return neutralPublicHours()
      }

      const limit = clampEntriesLimit(query.limit)
      const [totals, page] = await Promise.all([
        deps.repo.totalsFor(userId),
        visibility.items
          ? deps.repo.listEntries({
              userId,
              cursor: parseTimeCursor(query.cursor),
              limit,
              sources: ["event"],
            })
          : Promise.resolve({ items: [], nextCursor: null }),
      ])

      return {
        visible: true,
        totalHours: totals.totalHours,
        byJurisdiction: totals.byJurisdiction,
        items: page.items.map(toVolunteerHoursEntryDTO),
        // ALWAYS 0 since 2026-07-28: report filings are not volunteer service and are no longer credited
        // (0065 voided every historical row). The wire field stays — it is `.default(0)` in @civfix/shared
        // and removing it would be a hard break for shipped clients — but nothing reads the ledger for it
        // any more, so a stray un-voided row can never surface as public "report hours".
        reportHours: 0,
        nextCursor: page.nextCursor,
      }
    },

    /**
     * C10 — the read-back of what has already been logged for one event.
     *
     * An acting host (organizer|cohost) gets `scope: "all"` so the log form is prefilled instead of
     * double-crediting. Anyone else gets `scope: "self"` and at most their own row — plus `anyLogged`,
     * which is what lets the attendee receipt distinguish "the host hasn't logged yet" (pending) from
     * "the host logged and did not credit me" (not-credited). A NON-member gets an empty `scope: "self"`
     * with NO `anyLogged`: they have no receipt to render and telling them whether a private event's
     * hours exist is a disclosure with no reader.
     */
    async getEventHours(cleanupId: string, viewerId: string): Promise<EventHoursResponse> {
      const cleanup = await deps.cleanups.load(cleanupId)
      if (cleanup === null) throw AppError.notFound("Event not found")

      const role = await deps.cleanups.roleOf(cleanupId, viewerId)
      if (role === null) return { scope: "self", entries: [] }

      if (role === "organizer" || role === "cohost") {
        const ledger = await deps.repo.listEventHours(cleanupId, null)
        return {
          scope: "all",
          entries: ledger.entries.map(toEventHoursRow),
          // Derivable from `entries` on this branch; set anyway so both branches carry the field.
          anyLogged: ledger.entries.length > 0,
        }
      }

      const ledger = await deps.repo.listEventHours(cleanupId, viewerId)
      return {
        scope: "self",
        entries: ledger.entries.map(toEventHoursRow),
        anyLogged: ledger.anyLogged,
      }
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
      // L23: bound the array before doing any per-entry work (the shared schema now caps it too).
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

      const result = await deps.repo.logEventHours({
        actorId: input.actorId,
        cleanupId: input.cleanupId,
        geoid: cleanup.jurisdictionGeoid,
        entries: input.entries,
      })
      await notifyHoursLogged(
        { id: input.cleanupId, title: cleanup.title },
        result.changed,
        input.actorId,
      )
      return { credited: result.credited }
    },

    async leaderboard(
      geoid: string,
      query: LeaderboardQuery,
      viewerId: string | null = null,
    ): Promise<LeaderboardResponse> {
      const limit = clampLimit(query.limit)
      const offset = clampOffset(query.offset)
      // An OMITTED limit is the full board (what every shipped client sends), so it gets the extras;
      // an explicit limit only does when it asks for at least a full board's worth. See the threshold's
      // banner — comparing the CLAMPED limit here silently disabled B48 for the default request.
      const withExtras = query.limit === undefined || limit >= LEADERBOARD_EXTRAS_MIN_LIMIT
      const page = await deps.repo.leaderboard(geoid, limit, offset, viewerId, withExtras)
      return {
        geoid,
        jurisdictionName: page.jurisdictionName,
        entries: page.entries,
        nextOffset: page.nextOffset,
        // Absent on deep pages (DB B48) and on the preview, rather than sent as a misleading null.
        ...(page.participantCount !== null ? { participantCount: page.participantCount } : {}),
        // Absent for anonymous viewers and for the preview; NULL (present) means "you are not ranked
        // here", which is a different statement the client renders differently.
        ...(viewerId !== null && withExtras
          ? { viewerRank: page.viewerRank, viewerHours: page.viewerHours }
          : {}),
      }
    },
  }
}
