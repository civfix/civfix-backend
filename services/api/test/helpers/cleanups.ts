/**
 * Offline cleanups test helper: an in-memory CleanupRepository (+ a tiny users store for the organizer
 * person join).
 *
 * Mirrors the auth/media/reports in-memory seams so the cleanup SERVICE and the cleanup HTTP ROUTES can
 * be exercised with NO database (no Docker). It is faithful to the Drizzle/PostGIS impl's observable
 * contract:
 *   - createCleanupTx is "atomic": it inserts the cleanup AND the organizer's cleanup_members(organizer)
 *     row together (membership == chat membership). There is no half-created state to observe.
 *   - joinCleanupTx upserts a member row idempotently (re-joining is a no-op) and returns whether the
 *     cleanup exists; leaveCleanup deletes a member row and returns whether the cleanup exists.
 *   - listCleanups filters by when (upcoming = scheduled_at >= now and status != cancelled; past =
 *     scheduled_at < now; omitted = exclude cancelled), optional bbox (point-in-envelope), optional near
 *     (order by distance), and pages with a keyset cursor.
 *
 * The Drizzle-backed repository is covered by the Docker-gated integration test; this fake exercises the
 * same CleanupRepository seam locally.
 */

import { randomUUID } from "node:crypto"
import type {
  AttendeeView,
  CleanupBBox,
  CleanupPersonView,
  CleanupRecord,
  CleanupRepository,
  CreateCleanupTxArgs,
  ListAttendeesArgs,
  ListCleanupsFilters,
  NearPoint,
} from "../../src/services/cleanup-service.js"

/** A stored cleanup (the persisted fields; geom is kept decoded as lat/lng). */
interface StoredCleanup {
  id: string
  organizerUserId: string
  type: CleanupRecord["type"]
  title: string
  description: string | null
  lat: number
  lng: number
  scheduledAt: Date
  status: CleanupRecord["status"]
  bring: string[] | null
  address: string | null
  createdAt: Date
}

/** A stored membership row (cleanup_members). */
interface StoredMember {
  cleanupId: string
  userId: string
  role: "organizer" | "member"
}

/** A stored user (the subset the organizer person join needs). */
interface StoredUser {
  id: string
  displayName: string
  handle: string | null
  bio: string | null
}

/**
 * Great-circle distance in metres between two lat/lng points (haversine). Used to mirror the Drizzle
 * impl's ST_Distance(geography) ordering for `near` listings closely enough for deterministic tests.
 */
export function haversineMeters(a: NearPoint, b: NearPoint): number {
  const R = 6371008.8 // mean Earth radius (m), matching PostGIS geography defaults closely.
  const toRad = (d: number): number => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** An in-memory CleanupRepository faithful to the Drizzle impl's observable behavior. */
export class InMemoryCleanupRepository implements CleanupRepository {
  readonly cleanups = new Map<string, StoredCleanup>()
  readonly members: StoredMember[] = []
  readonly users = new Map<string, StoredUser>()
  /** Follow edges as "<followerId>:<followeeId>" so listAttendees can resolve isFollowing. */
  readonly follows = new Set<string>()

  /** Injectable clock so when-filters are deterministic. Defaults to real now. */
  now: () => Date = () => new Date()

  /** Test helper: seed a user so the organizer person join resolves. Returns the id. */
  seedUser(over: Partial<StoredUser> = {}): StoredUser {
    const user: StoredUser = {
      id: over.id ?? randomUUID(),
      displayName: over.displayName ?? "Organizer",
      handle: over.handle ?? null,
      bio: over.bio ?? null,
    }
    this.users.set(user.id, user)
    return user
  }

  /** Test helper: record that `followerId` follows `followeeId` (drives listAttendees' isFollowing). */
  seedFollow(followerId: string, followeeId: string): void {
    this.follows.add(`${followerId}:${followeeId}`)
  }

  /** Test helper: seed a cleanup directly (and optionally its organizer membership). */
  seedCleanup(over: Partial<StoredCleanup> & { id?: string }): StoredCleanup {
    const cleanup: StoredCleanup = {
      id: over.id ?? randomUUID(),
      organizerUserId: over.organizerUserId ?? randomUUID(),
      type: over.type ?? "site",
      title: over.title ?? "Beach cleanup",
      description: over.description ?? null,
      lat: over.lat ?? 34.0,
      lng: over.lng ?? -118.49,
      scheduledAt: over.scheduledAt ?? new Date(Date.now() + 86_400_000),
      status: over.status ?? "upcoming",
      bring: over.bring ?? null,
      address: over.address ?? null,
      createdAt: over.createdAt ?? new Date(),
    }
    this.cleanups.set(cleanup.id, cleanup)
    // Ensure the organizer person can be joined; seed a default user when absent.
    if (!this.users.has(cleanup.organizerUserId)) {
      this.seedUser({ id: cleanup.organizerUserId })
    }
    // The organizer is always a member (mirrors createCleanupTx).
    if (!this.members.some((m) => m.cleanupId === cleanup.id && m.userId === cleanup.organizerUserId)) {
      this.members.push({ cleanupId: cleanup.id, userId: cleanup.organizerUserId, role: "organizer" })
    }
    return cleanup
  }

  private personView(userId: string): CleanupPersonView {
    const u = this.users.get(userId)
    return {
      id: userId,
      displayName: u?.displayName ?? "Unknown",
      handle: u?.handle ?? null,
      bio: u?.bio ?? null,
    }
  }

  private memberCountOf(cleanupId: string): number {
    return this.members.filter((m) => m.cleanupId === cleanupId).length
  }

  private toRecord(c: StoredCleanup, near: NearPoint | null): CleanupRecord {
    return {
      id: c.id,
      organizerUserId: c.organizerUserId,
      type: c.type,
      title: c.title,
      description: c.description,
      lat: c.lat,
      lng: c.lng,
      scheduledAt: c.scheduledAt,
      status: c.status,
      bring: c.bring,
      address: c.address,
      createdAt: c.createdAt,
      going: this.memberCountOf(c.id),
      dist: near !== null ? haversineMeters(near, { lat: c.lat, lng: c.lng }) : null,
      organizer: this.personView(c.organizerUserId),
    }
  }

  createCleanupTx(args: CreateCleanupTxArgs): Promise<CleanupRecord> {
    const cleanup: StoredCleanup = {
      id: args.cleanupId,
      organizerUserId: args.organizerUserId,
      type: args.type,
      title: args.title,
      description: args.description,
      lat: args.lat,
      lng: args.lng,
      scheduledAt: args.scheduledAt,
      status: args.status,
      bring: args.bring,
      address: args.address,
      createdAt: this.now(),
    }
    this.cleanups.set(cleanup.id, cleanup)
    // Auto-join the organizer atomically (same step as the row insert).
    this.members.push({ cleanupId: cleanup.id, userId: cleanup.organizerUserId, role: "organizer" })
    if (!this.users.has(cleanup.organizerUserId)) {
      this.seedUser({ id: cleanup.organizerUserId })
    }
    return Promise.resolve(this.toRecord(cleanup, null))
  }

  findCleanupById(id: string, near: NearPoint | null): Promise<CleanupRecord | null> {
    const c = this.cleanups.get(id)
    return Promise.resolve(c ? this.toRecord(c, near) : null)
  }

  listCleanups(
    filters: ListCleanupsFilters,
  ): Promise<{ records: CleanupRecord[]; nextCursor: string | null }> {
    const nowMs = this.now().getTime()
    const near = filters.near ?? null

    const inBox = (c: StoredCleanup, bbox: CleanupBBox): boolean =>
      c.lng >= bbox.west && c.lng <= bbox.east && c.lat >= bbox.south && c.lat <= bbox.north

    let all = [...this.cleanups.values()].filter((c) => {
      // when filter (mirrors buildWhenFilter).
      if (filters.when === "upcoming") {
        if (!(c.scheduledAt.getTime() >= nowMs && c.status !== "cancelled")) return false
      } else if (filters.when === "past") {
        if (!(c.scheduledAt.getTime() < nowMs)) return false
      } else if (c.status === "cancelled") {
        return false
      }
      // bbox filter.
      if (filters.bbox !== undefined && !inBox(c, filters.bbox)) return false
      return true
    })

    if (near !== null) {
      // Order by distance ASC, id ASC; keyset cursor `${dist}|${id}`.
      const withDist = all
        .map((c) => ({ c, dist: haversineMeters(near, { lat: c.lat, lng: c.lng }) }))
        .sort((a, b) => (a.dist !== b.dist ? a.dist - b.dist : a.c.id < b.c.id ? -1 : 1))
      const cursor = parseNearCursor(filters.cursor)
      const after =
        cursor !== null
          ? withDist.filter(
              (x) => x.dist > cursor.dist || (x.dist === cursor.dist && x.c.id > cursor.id),
            )
          : withDist
      const hasMore = after.length > filters.limit
      const page = hasMore ? after.slice(0, filters.limit) : after
      const last = page[page.length - 1]
      const records = page.map((x) => this.toRecord(x.c, near))
      const nextCursor = hasMore && last ? `${last.dist}|${last.c.id}` : null
      return Promise.resolve({ records, nextCursor })
    }

    // Non-near: order by scheduled_at (DESC for past, else ASC), id tiebreak; cursor `${iso}|${id}`.
    const past = filters.when === "past"
    all = all.sort((a, b) => {
      const cmp = a.scheduledAt.getTime() - b.scheduledAt.getTime()
      if (cmp !== 0) return past ? -cmp : cmp
      const idCmp = a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      return past ? -idCmp : idCmp
    })
    const cursor = parseTimeCursor(filters.cursor)
    const after =
      cursor !== null
        ? all.filter((c) => {
            const t = c.scheduledAt.getTime()
            const ct = cursor.at.getTime()
            if (past) return t < ct || (t === ct && c.id < cursor.id)
            return t > ct || (t === ct && c.id > cursor.id)
          })
        : all
    const hasMore = after.length > filters.limit
    const page = hasMore ? after.slice(0, filters.limit) : after
    const last = page[page.length - 1]
    const records = page.map((c) => this.toRecord(c, null))
    const nextCursor = hasMore && last ? `${last.scheduledAt.toISOString()}|${last.id}` : null
    return Promise.resolve({ records, nextCursor })
  }

  isMember(cleanupId: string, userId: string): Promise<boolean> {
    return Promise.resolve(
      this.members.some((m) => m.cleanupId === cleanupId && m.userId === userId),
    )
  }

  memberCount(cleanupId: string): Promise<number> {
    return Promise.resolve(this.memberCountOf(cleanupId))
  }

  organizerOf(cleanupId: string): Promise<string | null> {
    const c = this.cleanups.get(cleanupId)
    return Promise.resolve(c ? c.organizerUserId : null)
  }

  joinCleanupTx(cleanupId: string, userId: string): Promise<boolean> {
    if (!this.cleanups.has(cleanupId)) return Promise.resolve(false)
    if (!this.members.some((m) => m.cleanupId === cleanupId && m.userId === userId)) {
      this.members.push({ cleanupId, userId, role: "member" })
    }
    return Promise.resolve(true)
  }

  leaveCleanup(cleanupId: string, userId: string): Promise<boolean> {
    if (!this.cleanups.has(cleanupId)) return Promise.resolve(false)
    const idx = this.members.findIndex((m) => m.cleanupId === cleanupId && m.userId === userId)
    if (idx >= 0) this.members.splice(idx, 1)
    return Promise.resolve(true)
  }

  listAttendees(args: ListAttendeesArgs): Promise<AttendeeView[]> {
    const { cleanupId, viewerId, onlyFollowed, limit } = args
    const follows = (userId: string): boolean =>
      viewerId !== null && this.follows.has(`${viewerId}:${userId}`)

    // Members of this cleanup, organizer-first then insertion order (mirrors joined_at ASC in the
    // Drizzle impl, since members are appended in join order).
    const ordered = this.members
      .map((m, idx) => ({ m, idx }))
      .filter((x) => x.m.cleanupId === cleanupId)
      .sort((a, b) => {
        const aOrg = a.m.role === "organizer" ? 1 : 0
        const bOrg = b.m.role === "organizer" ? 1 : 0
        if (aOrg !== bOrg) return bOrg - aOrg
        return a.idx - b.idx
      })

    let views: AttendeeView[] = ordered.map((x) => {
      const view = this.personView(x.m.userId)
      return { ...view, isFollowing: follows(x.m.userId) }
    })
    if (onlyFollowed) views = views.filter((v) => v.isFollowing)
    return Promise.resolve(views.slice(0, limit))
  }
}

/** Parse a `${dist}|${id}` near cursor; null when absent/malformed. Mirrors the Drizzle impl. */
function parseNearCursor(cursor: string | null): { dist: number; id: string } | null {
  if (cursor === null) return null
  const idx = cursor.indexOf("|")
  if (idx <= 0) return null
  const dist = Number(cursor.slice(0, idx))
  const id = cursor.slice(idx + 1)
  if (!Number.isFinite(dist) || id.length === 0) return null
  return { dist, id }
}

/** Parse an `${iso}|${id}` time cursor; null when absent/malformed. Mirrors the Drizzle impl. */
function parseTimeCursor(cursor: string | null): { at: Date; id: string } | null {
  if (cursor === null) return null
  const idx = cursor.indexOf("|")
  if (idx <= 0) return null
  const iso = cursor.slice(0, idx)
  const id = cursor.slice(idx + 1)
  const at = new Date(iso)
  if (Number.isNaN(at.getTime()) || id.length === 0) return null
  return { at, id }
}
