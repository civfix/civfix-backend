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
  CleanupDTO,
  CleanupStatus,
  CleanupType,
  CreateCleanupRequest,
  ListCleanupsRequest,
  PersonDTO,
} from "@civfix/shared"

// ---------------------------------------------------------------------------
// Config constants
// ---------------------------------------------------------------------------

/** Default page size for listCleanups when the request omits `limit`. Matches the shared cap of 50. */
export const CLEANUPS_DEFAULT_LIMIT = 20

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

/** The organizer's person fields as the read projects them (avatar gradient is derived in the service). */
export interface CleanupPersonView {
  id: string
  displayName: string
  handle: string | null
  bio: string | null
}

/** Everything the create transaction needs to persist a cleanup + the organizer membership atomically. */
export interface CreateCleanupTxArgs {
  cleanupId: string
  organizerUserId: string
  type: CleanupType
  title: string
  description: string | null
  lat: number
  lng: number
  scheduledAt: Date
  status: CleanupStatus
  bring: string[] | null
  address: string | null
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
  when: "upcoming" | "past" | undefined
  bbox: CleanupBBox | undefined
  near: NearPoint | undefined
  cursor: string | null
  limit: number
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
 * Build the organizer PersonDTO from the joined person view. followers/following are 0 and isFollowing
 * false in the cleanup context (the cleanups domain does not load social graph counts; the social step
 * owns those). avatar is the shared derived gradient so the client can render an initials chip.
 */
export function toOrganizerPerson(view: CleanupPersonView): PersonDTO {
  return {
    id: view.id,
    name: view.displayName,
    handle: view.handle,
    bio: view.bio,
    avatar: avatarGradient(view.id),
    followers: 0,
    following: 0,
    isFollowing: false,
  }
}

/**
 * Project a CleanupRecord into the wire CleanupDTO. `joined` is supplied by the caller (it depends on the
 * viewer). `dist` is included only when the record carries a distance (a `near` listing). `address` is
 * echoed (null when never set). `bring` defaults to [] so the DTO's required array is always present.
 */
export function toCleanupDTO(record: CleanupRecord, joined: boolean): CleanupDTO {
  return {
    id: record.id,
    title: record.title,
    type: record.type,
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
  /** Injectable id factory (defaults to crypto.randomUUID) for deterministic tests. */
  newId?: () => string
  /** Injectable clock (defaults to Date.now) so created/scheduled comparisons are deterministic. */
  now?: () => Date
}

export interface CleanupService {
  createCleanup(input: CreateCleanupRequest, organizerUserId: string): Promise<CleanupDTO>
  listCleanups(
    req: ListCleanupsRequest,
    viewer: CleanupViewer,
  ): Promise<{ items: CleanupDTO[]; nextCursor: string | null }>
  getCleanup(id: string, viewer: CleanupViewer): Promise<CleanupDTO>
  joinCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }>
  leaveCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }>
}

export function makeCleanupService(deps: CleanupServiceDeps): CleanupService {
  const newId = deps.newId ?? (() => randomUUID())
  // `now` is reserved for future status transitions; reading it keeps the dep meaningful + lints clean.
  void (deps.now ?? (() => new Date()))

  /** Resolve whether the viewer is a member of a cleanup (false for anonymous viewers, cheaply). */
  async function viewerJoined(cleanupId: string, viewer: CleanupViewer): Promise<boolean> {
    if (viewer.userId === null) return false
    return deps.repo.isMember(cleanupId, viewer.userId)
  }

  return {
    async createCleanup(
      input: CreateCleanupRequest,
      organizerUserId: string,
    ): Promise<CleanupDTO> {
      const cleanupId = newId()
      // Insert the cleanup + the organizer's membership in ONE transaction (membership == chat
      // membership, atomic). status starts "upcoming". scheduledAt is the validated ISO string -> Date.
      const record = await deps.repo.createCleanupTx({
        cleanupId,
        organizerUserId,
        type: input.type,
        title: input.title,
        description: input.description ?? null,
        lat: input.lat,
        lng: input.lng,
        scheduledAt: new Date(input.scheduledAt),
        status: "upcoming",
        bring: input.bring ?? null,
        address: input.address ?? null,
      })
      // The organizer auto-joined, so joined=true. going reflects the freshly-counted membership (>=1).
      return toCleanupDTO(record, true)
    },

    async listCleanups(
      req: ListCleanupsRequest,
      viewer: CleanupViewer,
    ): Promise<{ items: CleanupDTO[]; nextCursor: string | null }> {
      const filters: ListCleanupsFilters = {
        when: req.when,
        bbox: req.bbox,
        near: req.near,
        cursor: req.cursor ?? null,
        limit: req.limit ?? CLEANUPS_DEFAULT_LIMIT,
      }
      const { records, nextCursor } = await deps.repo.listCleanups(filters)

      // Resolve `joined` per record for the viewer. Anonymous viewers are never joined (skip the probe).
      const items = await Promise.all(
        records.map(async (record) => toCleanupDTO(record, await viewerJoined(record.id, viewer))),
      )
      return { items, nextCursor }
    },

    async getCleanup(id: string, viewer: CleanupViewer): Promise<CleanupDTO> {
      // getCleanup has no `near` context, so distance is always null here.
      const record = await deps.repo.findCleanupById(id, null)
      if (!record) throw AppError.notFound("Cleanup not found")
      const joined = await viewerJoined(id, viewer)
      return toCleanupDTO(record, joined)
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
  }
}
