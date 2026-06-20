/**
 * Cleanup service: the create/list/get/join/leave half of the cleanups domain, plus the membership
 * that doubles as chat-room membership.
 *
 * All DB access sits behind a CleanupRepository seam (Drizzle/PostGIS impl in
 * cleanup-repository.drizzle.ts; an in-memory impl in the offline tests), mirroring the reports/auth
 * pattern so the service is unit-testable with no database and no Docker.
 *
 * MEMBERSHIP == CHAT MEMBERSHIP, ATOMIC (the Phase-1 done-criterion):
 *   A cleanup_members row is the single source of truth for both "is going" and "may chat". createCleanup
 *   inserts the cleanups row AND the organizer's cleanup_members(role 'organizer') row in ONE transaction
 *   (createCleanupTx), so an organizer is never left able to see their event but unable to chat in it, and
 *   a rolled-back create never leaves an orphan membership. joinCleanup upserts a cleanup_members(role
 *   'member') row (idempotent: re-joining is a no-op), which is exactly what the WS gateway checks before
 *   admitting a socket to room <cleanupId>. There is no separate chat-membership table to drift.
 *
 * ORGANIZER-CANNOT-LEAVE (documented policy): leaveCleanup refuses to remove the organizer's own
 * membership (a CONFLICT). Rationale for Phase 1: every cleanup must always have exactly one organizer,
 * and reassigning ownership is out of scope; an organizer who wants to end an event cancels it (a later
 * status transition) rather than abandoning it. A plain member leaving is always allowed and idempotent.
 *
 * SPATIAL ACCESS RULE (same as the report/jurisdiction code): every geometry read/write goes through the
 * raw postgres-js tag wrapped in PostGIS functions (ST_SetSRID(ST_MakePoint(lng,lat),4326) on write;
 * ST_X/ST_Y on read; ST_MakeEnvelope/ST_Distance for bbox/near), never through the Drizzle ORM.
 */

import { randomUUID } from "node:crypto"
import { AppError, avatarGradient } from "@civfix/shared"
import type {
  CleanupAttendeesResponse,
  CleanupDTO,
  CleanupStatus,
  CleanupType,
  CreateCleanupRequest,
  EventKind,
  LinkedEventRef,
  LinkedReportRef,
  ListCleanupsRequest,
  PersonDTO,
  ReportCategory,
  ReportStatus,
  ReportType,
  UpdateCleanupRequest,
} from "@civfix/shared"

// ---------------------------------------------------------------------------
// Config constants
// ---------------------------------------------------------------------------

/** Default page size for listCleanups when the request omits `limit`. Matches the shared cap of 50. */
export const CLEANUPS_DEFAULT_LIMIT = 20

/**
 * Max attendee names returned by listAttendees. Cleanups are neighborhood-scale, so a generous flat cap
 * (no pagination) is enough for the "who's going" strip; the full `going` count is always returned
 * alongside so the client can show "+N others" when the roster exceeds this.
 */
export const ATTENDEES_DEFAULT_LIMIT = 50

/**
 * Soft cap on the member ids a thread-unread signal fans out to per cleanup message (listMemberIds).
 * Cleanups are neighborhood-scale so this is realistically never hit; the cap is a defensive bound so a
 * pathologically large cleanup cannot emit an unbounded set of PUBLISHes on every send.
 */
export const THREAD_SIGNAL_MEMBER_CAP = 500

// ---------------------------------------------------------------------------
// Repository seam (structural views; faked in tests)
// ---------------------------------------------------------------------------

/**
 * The persisted cleanup row the service projects into a CleanupDTO (geom already decoded to lat/lng).
 * `organizer*` are the denormalized organizer person fields the read joins in so the DTO can be built
 * without a second round-trip. `going` is the member count and `dist` the optional distance (metres)
 * when the query was a `near` ordering.
 */
export interface CleanupRecord {
  id: string
  organizerUserId: string
  type: CleanupType
  /** cleanup vs other_volunteer (0018); only 'cleanup' events may link reports / show the gallery. */
  eventKind: EventKind
  title: string
  description: string | null
  lat: number
  lng: number
  scheduledAt: Date
  status: CleanupStatus
  bring: string[] | null
  address: string | null
  createdAt: Date
  /** Number of cleanup_members rows (the "going" count). */
  going: number
  /** Distance in metres from the `near` point, when listing by proximity; otherwise null. */
  dist: number | null
  /** The organizer's person fields, joined from users. */
  organizer: CleanupPersonView
}

/**
 * A report linked to a cleanup, as loadLinkedReportsForCleanups projects it (geom decoded, the report's
 * ready-media thumb resolved, the junction's linked_at carried). Only published+public reports are
 * returned (held/hidden never leak). The service presigns `thumbKey` into the LinkedReportRef thumbUrl.
 */
export interface LinkedReportView {
  /** The cleanup this link belongs to (so a batched load can regroup by cleanup). */
  cleanupId: string
  id: string
  category: ReportCategory
  /**
   * The report's fine-grained issue type (0021); coexists with category. OPTIONAL on the view so the
   * cleanup repo SELECT can populate it incrementally — when absent the additive LinkedReportRef.type is
   * simply omitted (it is an optional contract field).
   */
  type?: ReportType
  title: string | null
  status: ReportStatus
  lat: number
  lng: number
  addr: string | null
  /** The report's first ready-media thumb object key (or its r2 key), or null when no ready media. */
  thumbKey: string | null
  linkedAt: Date
}

/**
 * A cleanup (event) a report is linked to, as loadLinkedEventsForReports projects it. Carries the
 * organizer person fields + the going count + eventKind + the real cleanup lifecycle status so the
 * service can build the LinkedEventRef (which embeds a full PersonDTO organizer). `reportId` lets a
 * batched load regroup by report.
 */
export interface LinkedEventView {
  /** The report this link belongs to (so a batched load can regroup by report). */
  reportId: string
  id: string
  title: string
  eventKind: EventKind
  /** The cleanup's real lifecycle status, so the report's "Cleanup events" gallery reads accurately. */
  status: CleanupStatus
  scheduledAt: Date
  lat: number
  lng: number
  going: number
  organizer: CleanupPersonView
  linkedAt: Date
}

/** The organizer's person fields as the read projects them (avatar gradient is derived in the service). */
export interface CleanupPersonView {
  id: string
  displayName: string
  handle: string | null
  bio: string | null
  /** Whether the organizer is document-verified (drives the event host's verified mark). Optional: a read
   * that does not join user_verification leaves it undefined ⇒ rendered as not verified. */
  verified?: boolean
}

/** An attendee row: the same person fields as the organizer view plus the viewer's follow relationship. */
export interface AttendeeView extends CleanupPersonView {
  /** Whether the viewer follows this attendee (always false for an anonymous viewer). */
  isFollowing: boolean
}

/** Arguments for the attendee roster read (the service resolves `onlyFollowed`/`limit` from the viewer). */
export interface ListAttendeesArgs {
  cleanupId: string
  /** The signed-in viewer, or null when anonymous. Drives the per-row `isFollowing`. */
  viewerId: string | null
  /**
   * When true, return only attendees the viewer follows (the "not yet RSVP'd" rule). An anonymous viewer
   * follows no one, so this yields an empty roster.
   */
  onlyFollowed: boolean
  /** Max rows to return (the service passes ATTENDEES_DEFAULT_LIMIT). */
  limit: number
}

/** Everything the create transaction needs to persist a cleanup + the organizer membership atomically. */
export interface CreateCleanupTxArgs {
  cleanupId: string
  organizerUserId: string
  type: CleanupType
  eventKind: EventKind
  title: string
  description: string | null
  lat: number
  lng: number
  scheduledAt: Date
  status: CleanupStatus
  bring: string[] | null
  address: string | null
  /**
   * Report ids to link to the new event in the SAME create transaction. The repo inserts a cleanup_reports
   * row + a cleanup_timeline 'report_linked' row per id (filtered to ids that exist; visibility is checked
   * by the service before this call). Empty array = no links. Never set for a non-cleanup eventKind.
   */
  linkedReportIds: string[]
}

/** A scalar PATCH of an existing cleanup (only the supplied fields change). Geometry via lat+lng pair. */
export interface UpdateCleanupPatch {
  title?: string
  description?: string | null
  eventKind?: EventKind
  type?: CleanupType
  scheduledAt?: Date
  /** lat+lng MUST be supplied together (the repo rebuilds geom only when both are present). */
  lat?: number
  lng?: number
  address?: string | null
  bring?: string[] | null
}

/** A point the caller can sort/measure distance from (for `near` listings). */
export interface NearPoint {
  lat: number
  lng: number
}

/** A bbox (west/south/east/north) - declared structurally to avoid importing the zod type here. */
export interface CleanupBBox {
  west: number
  south: number
  east: number
  north: number
}

/** Filters for listCleanups, resolved from ListCleanupsRequest by the service. */
export interface ListCleanupsFilters {
  when: "upcoming" | "past" | "attending" | undefined
  bbox: CleanupBBox | undefined
  near: NearPoint | undefined
  cursor: string | null
  limit: number
  /**
   * The signed-in viewer (or null), used ONLY by `when: "attending"` to restrict the list to events the
   * viewer is a member of (organizer or RSVP'd). Ignored for the other `when` values. Optional so existing
   * non-attending callers/tests need not supply it; the service always sets it from the viewer.
   */
  viewerId?: string | null
}

/**
 * Persistence seam for the cleanups domain. The production impl runs Drizzle/PostGIS (with the
 * create + organizer-membership insert in ONE transaction); the offline tests pass an in-memory
 * implementation. Keeping ALL cleanup/membership access behind this interface is what makes the service
 * testable with no DB.
 */
export interface CleanupRepository {
  /**
   * Insert the cleanup row AND the organizer's cleanup_members(role 'organizer') row in a SINGLE
   * transaction, then read the row back (geom decoded, organizer joined, going counted) and return it.
   * This is the atomicity guarantee that membership == chat membership from creation onward.
   */
  createCleanupTx(args: CreateCleanupTxArgs): Promise<CleanupRecord>
  /**
   * Apply a scalar PATCH to an existing cleanup (only the supplied fields change). lat+lng (when both
   * present) rebuild geom; supplying neither leaves the position untouched. Returns false when the cleanup
   * does not exist. Does NOT touch links (the service reconciles those separately).
   */
  updateCleanup(id: string, patch: UpdateCleanupPatch): Promise<boolean>
  /**
   * Link reports to a cleanup: insert a cleanup_reports row (ON CONFLICT DO NOTHING) + a cleanup_timeline
   * 'report_linked' row per id that did not already exist on the event, all in one transaction. Ignores
   * ids already linked (idempotent). Returns the ids that were newly linked.
   */
  linkReports(cleanupId: string, reportIds: string[], actorId: string | null): Promise<string[]>
  /**
   * Unlink ONE report from a cleanup: delete the cleanup_reports row + append a cleanup_timeline
   * 'report_unlinked' row, in one transaction. Returns true when a link existed (and was removed), false
   * when there was no such link (idempotent no-op).
   */
  unlinkReport(cleanupId: string, reportId: string, actorId: string | null): Promise<boolean>
  /**
   * Reconcile a cleanup's links to EXACTLY `desiredIds`: link the ids not yet linked, unlink the currently
   * linked ids not in the desired set, each with its cleanup_timeline row. Returns the diff that was
   * applied ({ added, removed }). The full-desired-set semantics back the PATCH `linkedReportIds`.
   */
  reconcileLinkedReports(
    cleanupId: string,
    desiredIds: string[],
    actorId: string | null,
  ): Promise<{ added: string[]; removed: string[] }>
  /**
   * Batched load of the reports linked to a set of cleanups, grouped by cleanup id. Only published+public
   * (non-deleted) reports are returned (held/hidden never leak). An empty input yields an empty map.
   */
  loadLinkedReportsForCleanups(cleanupIds: string[]): Promise<Map<string, LinkedReportView[]>>
  /**
   * Batched load of the events (cleanups) a set of reports is linked to, grouped by report id. Carries the
   * organizer person fields + going count + eventKind so the service builds the LinkedEventRef. An empty
   * input yields an empty map.
   */
  loadLinkedEventsForReports(reportIds: string[]): Promise<Map<string, LinkedEventView[]>>
  /** Which of the given report ids are visible (published+public, non-deleted)? Used to validate links. */
  filterVisibleReportIds(reportIds: string[]): Promise<Set<string>>
  /**
   * Load a cleanup by id, decoding geom and joining the organizer + member count. `near` (when given)
   * adds the distance in metres. Returns null when the id does not exist.
   */
  findCleanupById(id: string, near: NearPoint | null): Promise<CleanupRecord | null>
  /**
   * Page cleanups under the given filters. Returns up to `limit` records plus the next cursor (null
   * when exhausted). Ordering is by distance ascending when `near` is set, else by scheduled_at (soonest
   * first for upcoming, most-recent first for past).
   */
  listCleanups(
    filters: ListCleanupsFilters,
  ): Promise<{ records: CleanupRecord[]; nextCursor: string | null }>
  /** Whether `userId` is a member of `cleanupId` (member or organizer). */
  isMember(cleanupId: string, userId: string): Promise<boolean>
  /**
   * Batched membership probe: of the given cleanup ids, which is `userId` a member of? Returns the joined
   * subset as a Set. An empty input yields an empty set (no query). Used by the list path to resolve
   * `joined` for a whole page in one query instead of one isMember probe per row.
   */
  membersOf(cleanupIds: string[], userId: string): Promise<Set<string>>
  /**
   * The user ids of a cleanup's members, capped at `limit` (a soft fan-out bound so a large cleanup does
   * not signal an unbounded set on every message). Used by the WS gateway to fan a thread-unread signal to
   * the room's members. Returns an empty list when the cleanup has no members.
   */
  listMemberIds(cleanupId: string, limit: number): Promise<string[]>
  /** Current member count for a cleanup (the "going" number). */
  memberCount(cleanupId: string): Promise<number>
  /** The organizer's user id for a cleanup, or null when the cleanup does not exist. */
  organizerOf(cleanupId: string): Promise<string | null>
  /**
   * Upsert a cleanup_members(role 'member') row in a transaction (idempotent: re-joining is a no-op).
   * Returns true when the cleanup exists (so the route can 404 a missing cleanup), false otherwise.
   */
  joinCleanupTx(cleanupId: string, userId: string): Promise<boolean>
  /**
   * Delete a cleanup_members row. Returns true when the cleanup exists, false when it does not. Deleting
   * a non-existent membership on an existing cleanup is a no-op that still returns true (idempotent).
   */
  leaveCleanup(cleanupId: string, userId: string): Promise<boolean>
  /**
   * The attendee roster for a cleanup: cleanup_members joined to their (non-deleted) user, with the
   * viewer's `isFollowing` per row. Ordered organizer-first then by join time. When `onlyFollowed` is
   * set, only attendees the viewer follows are returned. Capped at `limit`.
   */
  listAttendees(args: ListAttendeesArgs): Promise<AttendeeView[]>
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB, no IO)
// ---------------------------------------------------------------------------
// The avatar gradient is the shared deterministic helper (imported from @civfix/shared above). It
// previously had a DIVERGENT local HSL implementation here, which made the organizer/chat avatar differ
// from the people-list/profile avatar for the SAME user (the same person looked different across screens).
// Converging on the shared brand-palette avatarGradient fixes that: organizer + profile + chat now derive
// the identical [from, to] gradient from a user id.

/**
 * Build a PersonDTO from a joined cleanup person view + the viewer's follow relationship. followers/
 * following are 0 in the cleanup context (the cleanups domain does not load social-graph counts; the
 * social step owns those). avatar is the shared derived gradient so the client can render an initials
 * chip. Used for both the organizer and the attendee roster so their shapes never drift.
 */
export function toAttendeePersonDTO(view: CleanupPersonView, isFollowing: boolean): PersonDTO {
  return {
    id: view.id,
    name: view.displayName,
    handle: view.handle,
    bio: view.bio,
    avatar: avatarGradient(view.id),
    followers: 0,
    following: 0,
    isFollowing,
    ...(view.verified ? { verified: true } : {}),
  }
}

/**
 * Build the organizer PersonDTO from the joined person view. isFollowing is false here: the cleanups
 * domain does not load the viewer's follow edge for the organizer (the detail screen's Follow button
 * reads it from the dedicated social endpoint).
 */
export function toOrganizerPerson(view: CleanupPersonView): PersonDTO {
  return toAttendeePersonDTO(view, false)
}

/**
 * Project a CleanupRecord into the wire CleanupDTO. `joined` is supplied by the caller (it depends on the
 * viewer). `dist` is included only when the record carries a distance (a `near` listing). `address` is
 * echoed (null when never set). `bring` defaults to [] so the DTO's required array is always present.
 * `linkedReports` (the cleanup-coverage gallery, default []) is supplied by the caller (hydrated only on
 * the single-cleanup read; list rows omit it so the array default keeps them backward-compatible).
 */
export function toCleanupDTO(
  record: CleanupRecord,
  joined: boolean,
  linkedReports: LinkedReportRef[] = [],
): CleanupDTO {
  return {
    id: record.id,
    title: record.title,
    type: record.type,
    eventKind: record.eventKind,
    ...(record.description !== null ? { description: record.description } : {}),
    lat: record.lat,
    lng: record.lng,
    scheduledAt: record.scheduledAt.toISOString(),
    status: record.status,
    organizer: toOrganizerPerson(record.organizer),
    going: record.going,
    joined,
    bring: record.bring ?? [],
    address: record.address,
    ...(record.dist !== null ? { dist: record.dist } : {}),
    linkedReports,
  }
}

/**
 * Project a LinkedReportView into the wire LinkedReportRef. `thumbUrl` is the caller-resolved presigned
 * URL for the report's thumb (or null/omitted when there is none). title falls back to a generic label so
 * the ref's required `title` is always a string.
 */
export function toLinkedReportRef(
  view: LinkedReportView,
  thumbUrl: string | null,
): LinkedReportRef {
  return {
    id: view.id,
    category: view.category,
    // Additive fine-grained type (0021): emitted only when the view carries it (optional contract field).
    ...(view.type !== undefined ? { type: view.type } : {}),
    title: view.title ?? "Report",
    status: view.status,
    lat: view.lat,
    lng: view.lng,
    ...(view.addr !== null ? { addr: view.addr } : {}),
    ...(thumbUrl !== null ? { thumbUrl } : {}),
    linkedAt: view.linkedAt.toISOString(),
  }
}

/** Project a LinkedEventView into the wire LinkedEventRef (organizer projected to a PersonDTO). */
export function toLinkedEventRef(view: LinkedEventView): LinkedEventRef {
  return {
    id: view.id,
    title: view.title,
    eventKind: view.eventKind,
    status: view.status,
    scheduledAt: view.scheduledAt.toISOString(),
    lat: view.lat,
    lng: view.lng,
    going: view.going,
    organizer: toOrganizerPerson(view.organizer),
    linkedAt: view.linkedAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** A viewer context for read endpoints (a signed-in user, or anonymous). */
export interface CleanupViewer {
  userId: string | null
}

export interface CleanupServiceDeps {
  repo: CleanupRepository
  /**
   * Presign (or otherwise render) a linked report's thumb object key into a client-usable URL, wrapping
   * the Storage seam exactly like the report service. OPTIONAL: when omitted (offline tests), it defaults
   * to an identity pass-through (returns the raw key) so a test still sees a thumb without a storage SDK.
   */
  presignThumb?: (thumbKey: string) => Promise<string>
  /** Injectable id factory (defaults to crypto.randomUUID) for deterministic tests. */
  newId?: () => string
  /** Injectable clock (defaults to Date.now) so created/scheduled comparisons are deterministic. */
  now?: () => Date
}

export interface CleanupService {
  createCleanup(input: CreateCleanupRequest, organizerUserId: string): Promise<CleanupDTO>
  /**
   * Organizer edit (PATCH /cleanups/:id). HOST-GATED: the requester MUST be the organizer (else 403).
   * Applies the scalar patch; when `linkedReportIds` is present it reconciles the link set (and rejects
   * linking on a non-cleanup eventKind). Returns the updated CleanupDTO (hydrated linkedReports).
   */
  updateCleanup(
    id: string,
    patch: UpdateCleanupRequest,
    requesterUserId: string,
  ): Promise<CleanupDTO>
  listCleanups(
    req: ListCleanupsRequest,
    viewer: CleanupViewer,
  ): Promise<{ items: CleanupDTO[]; nextCursor: string | null }>
  getCleanup(id: string, viewer: CleanupViewer): Promise<CleanupDTO>
  joinCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }>
  leaveCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }>
  listAttendees(id: string, viewer: CleanupViewer): Promise<CleanupAttendeesResponse>
}

export function makeCleanupService(deps: CleanupServiceDeps): CleanupService {
  const newId = deps.newId ?? (() => randomUUID())
  // `now` is reserved for future status transitions; reading it keeps the dep meaningful + lints clean.
  void (deps.now ?? (() => new Date()))
  // Default to an identity pass-through (raw key) when no presigner is injected, so offline tests still
  // see the seeded thumb key; production wires the real Storage presigner so the gallery thumb renders.
  const presignThumb = deps.presignThumb ?? ((thumbKey: string) => Promise.resolve(thumbKey))

  /** Resolve whether the viewer is a member of a cleanup (false for anonymous viewers, cheaply). */
  async function viewerJoined(cleanupId: string, viewer: CleanupViewer): Promise<boolean> {
    if (viewer.userId === null) return false
    return deps.repo.isMember(cleanupId, viewer.userId)
  }

  /**
   * Hydrate a single cleanup's linkedReports gallery (presigning each report's thumb). Empty for a
   * non-cleanup eventKind (those carry no links). Used by getCleanup + updateCleanup.
   */
  async function hydrateLinkedReports(
    cleanupId: string,
    eventKind: EventKind,
  ): Promise<LinkedReportRef[]> {
    if (eventKind !== "cleanup") return []
    const grouped = await deps.repo.loadLinkedReportsForCleanups([cleanupId])
    const views = grouped.get(cleanupId) ?? []
    return Promise.all(
      views.map(async (v) => {
        const thumbUrl = v.thumbKey !== null ? await presignThumb(v.thumbKey) : null
        return toLinkedReportRef(v, thumbUrl)
      }),
    )
  }

  /**
   * Validate that every requested link id is visible (published+public). Throws a VALIDATION error
   * naming the offending ids otherwise, so a host cannot link a held/hidden/missing report.
   */
  async function assertReportsLinkable(reportIds: string[]): Promise<void> {
    if (reportIds.length === 0) return
    const visible = await deps.repo.filterVisibleReportIds(reportIds)
    const bad = reportIds.filter((id) => !visible.has(id))
    if (bad.length > 0) {
      throw AppError.validation({ linkedReportIds: `not linkable: ${bad.join(", ")}` })
    }
  }

  return {
    async createCleanup(
      input: CreateCleanupRequest,
      organizerUserId: string,
    ): Promise<CleanupDTO> {
      // CLEANUP-ONLY LINKING (decision 3): only a 'cleanup' event may carry linked reports; reject a
      // create that asks to link reports on an other_volunteer event.
      const linkedReportIds = input.linkedReportIds ?? []
      if (input.eventKind !== "cleanup" && linkedReportIds.length > 0) {
        throw AppError.validation({
          linkedReportIds: "only cleanup events can link reports",
        })
      }
      // Validate the requested links are visible (published+public) BEFORE the create tx so a bad id is a
      // clean 422 rather than a silently-dropped link.
      await assertReportsLinkable(linkedReportIds)

      const cleanupId = newId()
      // Insert the cleanup + the organizer's membership + the junction rows + 'report_linked' timeline rows
      // in ONE transaction (membership == chat membership, atomic). status starts "upcoming".
      const record = await deps.repo.createCleanupTx({
        cleanupId,
        organizerUserId,
        type: input.type,
        eventKind: input.eventKind,
        title: input.title,
        description: input.description ?? null,
        lat: input.lat,
        lng: input.lng,
        scheduledAt: new Date(input.scheduledAt),
        status: "upcoming",
        bring: input.bring ?? null,
        address: input.address ?? null,
        linkedReportIds,
      })
      // The organizer auto-joined, so joined=true. going reflects the freshly-counted membership (>=1).
      const linkedReports = await hydrateLinkedReports(cleanupId, record.eventKind)
      return toCleanupDTO(record, true, linkedReports)
    },

    async updateCleanup(
      id: string,
      patch: UpdateCleanupRequest,
      requesterUserId: string,
    ): Promise<CleanupDTO> {
      // HOST GATE: only the organizer may edit. Probe the organizer first so a missing cleanup 404s and a
      // non-organizer 403s before any write.
      const organizerId = await deps.repo.organizerOf(id)
      if (organizerId === null) throw AppError.notFound("Cleanup not found")
      if (organizerId !== requesterUserId) {
        throw AppError.forbidden("Only the organizer can edit this event.")
      }

      // Resolve the effective eventKind AFTER the patch (the patch may change it) so the cleanup-only rule
      // is enforced against the kind the event will have.
      const current = await deps.repo.findCleanupById(id, null)
      if (!current) throw AppError.notFound("Cleanup not found")
      const effectiveKind = patch.eventKind ?? current.eventKind

      // CLEANUP-ONLY LINKING (decision 3): reject a link reconcile on a non-cleanup event.
      if (patch.linkedReportIds !== undefined && effectiveKind !== "cleanup") {
        throw AppError.validation({
          linkedReportIds: "only cleanup events can link reports",
        })
      }
      // When the patch turns a cleanup INTO an other_volunteer event, its existing links must go (the
      // gallery is cleanup-only). Reconcile to the empty set unless the caller is supplying their own.
      const desiredLinks =
        patch.linkedReportIds !== undefined
          ? patch.linkedReportIds
          : effectiveKind !== "cleanup"
            ? []
            : null

      // Validate any newly desired links up front (clean 422 before the write).
      if (desiredLinks !== null && desiredLinks.length > 0) {
        await assertReportsLinkable(desiredLinks)
      }

      // Apply the scalar patch (the repo rebuilds geom only when both lat+lng are present).
      const scalarPatch: UpdateCleanupPatch = {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.eventKind !== undefined ? { eventKind: patch.eventKind } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.scheduledAt !== undefined ? { scheduledAt: new Date(patch.scheduledAt) } : {}),
        ...(patch.lat !== undefined ? { lat: patch.lat } : {}),
        ...(patch.lng !== undefined ? { lng: patch.lng } : {}),
        ...(patch.address !== undefined ? { address: patch.address } : {}),
        ...(patch.bring !== undefined ? { bring: patch.bring } : {}),
      }
      const updated = await deps.repo.updateCleanup(id, scalarPatch)
      if (!updated) throw AppError.notFound("Cleanup not found")

      // Reconcile links to the full desired set (when supplied or forced empty by a kind change).
      if (desiredLinks !== null) {
        await deps.repo.reconcileLinkedReports(id, desiredLinks, requesterUserId)
      }

      // Re-read the persisted state + hydrate the gallery for the response.
      const record = await deps.repo.findCleanupById(id, null)
      if (!record) throw AppError.notFound("Cleanup not found")
      const joined = await deps.repo.isMember(id, requesterUserId)
      const linkedReports = await hydrateLinkedReports(id, record.eventKind)
      return toCleanupDTO(record, joined, linkedReports)
    },

    async listCleanups(
      req: ListCleanupsRequest,
      viewer: CleanupViewer,
    ): Promise<{ items: CleanupDTO[]; nextCursor: string | null }> {
      // "attending" is viewer-scoped: an anonymous viewer has no memberships, so short-circuit to an empty
      // page rather than issuing a membership query that can only return nothing.
      if (req.when === "attending" && viewer.userId === null) {
        return { items: [], nextCursor: null }
      }
      const filters: ListCleanupsFilters = {
        when: req.when,
        bbox: req.bbox,
        near: req.near,
        cursor: req.cursor ?? null,
        limit: req.limit ?? CLEANUPS_DEFAULT_LIMIT,
        viewerId: viewer.userId,
      }
      const { records, nextCursor } = await deps.repo.listCleanups(filters)

      // Resolve `joined` for the WHOLE page in ONE membership query (was 1 isMember probe per row, an N+1).
      // Anonymous viewers are never joined, so skip the probe entirely (matches viewerJoined's fast path).
      const joinedIds =
        viewer.userId !== null
          ? await deps.repo.membersOf(records.map((r) => r.id), viewer.userId)
          : new Set<string>()
      const items = records.map((record) => toCleanupDTO(record, joinedIds.has(record.id)))
      return { items, nextCursor }
    },

    async getCleanup(id: string, viewer: CleanupViewer): Promise<CleanupDTO> {
      // getCleanup has no `near` context, so distance is always null here.
      const record = await deps.repo.findCleanupById(id, null)
      if (!record) throw AppError.notFound("Cleanup not found")
      const [joined, linkedReports] = await Promise.all([
        viewerJoined(id, viewer),
        hydrateLinkedReports(id, record.eventKind),
      ])
      return toCleanupDTO(record, joined, linkedReports)
    },

    async joinCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }> {
      const exists = await deps.repo.joinCleanupTx(id, userId)
      if (!exists) throw AppError.notFound("Cleanup not found")
      const going = await deps.repo.memberCount(id)
      return { joined: true, going }
    },

    async leaveCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }> {
      // The organizer cannot leave their own cleanup (documented policy; see file header). Probe the
      // organizer first so a missing cleanup 404s and an organizer self-leave 409s before any delete.
      const organizerId = await deps.repo.organizerOf(id)
      if (organizerId === null) throw AppError.notFound("Cleanup not found")
      if (organizerId === userId) {
        throw AppError.conflict("The organizer cannot leave their own cleanup.")
      }
      await deps.repo.leaveCleanup(id, userId)
      const going = await deps.repo.memberCount(id)
      return { joined: false, going }
    },

    async listAttendees(id: string, viewer: CleanupViewer): Promise<CleanupAttendeesResponse> {
      // Confirm the cleanup exists (404 like getCleanup) and read the authoritative `going` count.
      const record = await deps.repo.findCleanupById(id, null)
      if (!record) throw AppError.notFound("Cleanup not found")

      // RSVP unlocks the full roster; until then a viewer sees only attendees they follow. The organizer
      // counts as joined (they are always a member), so an organizer always sees everyone.
      const joined = await viewerJoined(id, viewer)
      const scope: CleanupAttendeesResponse["scope"] = joined ? "all" : "following"

      const views = await deps.repo.listAttendees({
        cleanupId: id,
        viewerId: viewer.userId,
        onlyFollowed: !joined,
        limit: ATTENDEES_DEFAULT_LIMIT,
      })
      const attendees = views.map((v) => toAttendeePersonDTO(v, v.isFollowing))
      // `going` is the FULL member count (not the possibly-filtered roster length) so the client can show
      // the real total and an "+N others" overflow regardless of how many names it may display.
      return { attendees, going: record.going, scope }
    },
  }
}
