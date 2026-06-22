/**
 * Offline social test helper: an in-memory SocialRepository (people, follow graph, profiles).
 *
 * Mirrors the auth/media/reports/cleanups in-memory seams so the social SERVICE and the social HTTP ROUTES
 * can be exercised with NO database (no Docker). It is faithful to the Drizzle impl's observable contract:
 *   - listPeople excludes the viewer + soft-deleted users, filters case-insensitively on handle OR
 *     display_name, orders by (display_name, id) ascending, and pages with a `${name}|${id}` keyset cursor;
 *   - addFollow is idempotent and reports `created` only on a NEW edge (so the new_follower hook fires
 *     once); removeFollow is idempotent; both report whether the followee exists;
 *   - follower/following counts are derived from the edge set;
 *   - pastEventsFor returns the cleanups the user organized OR attended, most recent first;
 *   - statsFor returns {reports, cleanups-organized}.
 *
 * The Drizzle-backed repository is covered by the Docker-gated integration test; this fake exercises the
 * same SocialRepository seam locally.
 */

import { randomUUID } from "node:crypto"
import type {
  PersonView,
  ProfileStats,
  SocialRepository,
} from "../../src/services/social-service.js"
import type { CleanupRecord } from "../../src/services/cleanup-service.js"

/** A stored user (the subset the directory/profile reads need). */
interface StoredUser {
  id: string
  displayName: string
  handle: string | null
  bio: string | null
  deletedAt: Date | null
  /** Whether this user is document-verified (stand-in for a user_verification row with status='verified'). */
  verified?: boolean
  /** The canonical avatar URL (stand-in for users.avatar_url); null/absent => the monogram fallback. */
  avatarUrl?: string | null
}

/** A stored follow edge. */
interface StoredFollow {
  followerId: string
  followeeId: string
}

/** A stored cleanup the profile pastEvents/stats read (kept as a ready-made CleanupRecord + attendees). */
interface StoredCleanup {
  record: CleanupRecord
  /** User ids who are members (the organizer is implicitly a member too). */
  attendees: Set<string>
}

/** An in-memory SocialRepository faithful to the Drizzle impl's observable behavior. */
export class InMemorySocialRepository implements SocialRepository {
  readonly users = new Map<string, StoredUser>()
  readonly follows: StoredFollow[] = []
  readonly cleanups: StoredCleanup[] = []
  /** Report counts keyed by reporter user id (stand-in for the reports table). */
  readonly reportCounts = new Map<string, number>()

  /** Seed a user. Returns the stored user. */
  seedUser(over: Partial<StoredUser> = {}): StoredUser {
    const user: StoredUser = {
      id: over.id ?? randomUUID(),
      displayName: over.displayName ?? "Person",
      handle: over.handle ?? null,
      bio: over.bio ?? null,
      deletedAt: over.deletedAt ?? null,
      ...(over.verified !== undefined ? { verified: over.verified } : {}),
      ...(over.avatarUrl !== undefined ? { avatarUrl: over.avatarUrl } : {}),
    }
    this.users.set(user.id, user)
    return user
  }

  /** Seed a follow edge (idempotent). */
  seedFollow(followerId: string, followeeId: string): void {
    if (!this.follows.some((f) => f.followerId === followerId && f.followeeId === followeeId)) {
      this.follows.push({ followerId, followeeId })
    }
  }

  /** Seed a cleanup (as a pre-built CleanupRecord) with its attendee set for pastEvents/stats. */
  seedCleanup(record: CleanupRecord, attendees: string[] = []): void {
    const set = new Set<string>(attendees)
    set.add(record.organizerUserId)
    this.cleanups.push({ record, attendees: set })
  }

  /** Seed a report count for a user (stand-in for inserting reports). */
  seedReports(userId: string, count: number): void {
    this.reportCounts.set(userId, count)
  }

  private toView(u: StoredUser): PersonView {
    return {
      id: u.id,
      displayName: u.displayName,
      handle: u.handle,
      bio: u.bio,
      followers: this.follows.filter((f) => f.followeeId === u.id).length,
      following: this.follows.filter((f) => f.followerId === u.id).length,
      verified: u.verified ?? false,
      // The in-memory fake has no media table; an uploaded avatar's r2 key is never exercised offline, so the
      // avatar key is always null (buildProfile then omits avatarUrl). The canonical avatar_url is seedable
      // directly so the list/people projection (toPersonDTO) can be asserted offline.
      avatarR2Key: null,
      avatarUrl: u.avatarUrl ?? null,
    }
  }

  listPeople(args: {
    viewerId: string | null
    q: string | null
    cursor: string | null
    limit: number
  }): Promise<{ items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null }> {
    const q = args.q !== null ? args.q.toLowerCase() : null
    let all = [...this.users.values()].filter((u) => {
      if (u.deletedAt !== null) return false
      if (args.viewerId !== null && u.id === args.viewerId) return false
      if (q !== null) {
        const inHandle = u.handle !== null && u.handle.toLowerCase().includes(q)
        const inName = u.displayName.toLowerCase().includes(q)
        if (!inHandle && !inName) return false
      }
      return true
    })

    // Order by (display_name, id) ascending (mirrors the Drizzle ORDER BY).
    all = all.sort((a, b) => {
      if (a.displayName !== b.displayName) return a.displayName < b.displayName ? -1 : 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

    const cursor = parseNameCursor(args.cursor)
    const after =
      cursor !== null
        ? all.filter((u) => {
            if (u.displayName !== cursor.name) return u.displayName > cursor.name
            return u.id > cursor.id
          })
        : all

    const hasMore = after.length > args.limit
    const page = hasMore ? after.slice(0, args.limit) : after
    const last = page[page.length - 1]
    const items = page.map((u) => ({
      ...this.toView(u),
      isFollowing:
        args.viewerId !== null &&
        this.follows.some((f) => f.followerId === args.viewerId && f.followeeId === u.id),
    }))
    const nextCursor = hasMore && last ? `${last.displayName}|${last.id}` : null
    return Promise.resolve({ items, nextCursor })
  }

  listFollowers(args: {
    id: string
    viewerId: string | null
    cursor: string | null
    limit: number
  }): Promise<{ items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null }> {
    // The people who follow `args.id`: the followers of that user.
    const followerIds = new Set(
      this.follows.filter((f) => f.followeeId === args.id).map((f) => f.followerId),
    )
    return this.connectionsPage(followerIds, args)
  }

  listFollowing(args: {
    id: string
    viewerId: string | null
    cursor: string | null
    limit: number
  }): Promise<{ items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null }> {
    // The people `args.id` follows: the followees of that user.
    const followeeIds = new Set(
      this.follows.filter((f) => f.followerId === args.id).map((f) => f.followeeId),
    )
    return this.connectionsPage(followeeIds, args)
  }

  /**
   * Page a set of connection ids (followers/following) into PersonViews + isFollowing flags, mirroring the
   * Drizzle connectionsPage: soft-deleted users excluded, ordered by (display_name, id) ascending, keyset
   * cursored on `${name}|${id}`. The viewer self is NOT excluded (a connections list legitimately includes
   * the viewer); isFollowing is relative to `viewerId`.
   */
  private connectionsPage(
    ids: ReadonlySet<string>,
    args: { viewerId: string | null; cursor: string | null; limit: number },
  ): Promise<{ items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null }> {
    let all = [...this.users.values()].filter((u) => u.deletedAt === null && ids.has(u.id))
    all = all.sort((a, b) => {
      if (a.displayName !== b.displayName) return a.displayName < b.displayName ? -1 : 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    const cursor = parseNameCursor(args.cursor)
    const after =
      cursor !== null
        ? all.filter((u) => {
            if (u.displayName !== cursor.name) return u.displayName > cursor.name
            return u.id > cursor.id
          })
        : all
    const hasMore = after.length > args.limit
    const page = hasMore ? after.slice(0, args.limit) : after
    const last = page[page.length - 1]
    const items = page.map((u) => ({
      ...this.toView(u),
      isFollowing:
        args.viewerId !== null &&
        this.follows.some((f) => f.followerId === args.viewerId && f.followeeId === u.id),
    }))
    const nextCursor = hasMore && last ? `${last.displayName}|${last.id}` : null
    return Promise.resolve({ items, nextCursor })
  }

  findPersonById(id: string): Promise<PersonView | null> {
    const u = this.users.get(id)
    if (!u || u.deletedAt !== null) return Promise.resolve(null)
    return Promise.resolve(this.toView(u))
  }

  findPersonByHandle(handle: string): Promise<PersonView | null> {
    // handle is citext server-side; match case-insensitively. Excludes soft-deleted + handle-less users.
    const needle = handle.toLowerCase()
    for (const u of this.users.values()) {
      if (u.deletedAt !== null) continue
      if (u.handle !== null && u.handle.toLowerCase() === needle) return Promise.resolve(this.toView(u))
    }
    return Promise.resolve(null)
  }

  isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    return Promise.resolve(
      this.follows.some((f) => f.followerId === followerId && f.followeeId === followeeId),
    )
  }

  addFollow(
    followerId: string,
    followeeId: string,
  ): Promise<{ exists: boolean; created: boolean }> {
    const target = this.users.get(followeeId)
    if (!target || target.deletedAt !== null) {
      return Promise.resolve({ exists: false, created: false })
    }
    const already = this.follows.some(
      (f) => f.followerId === followerId && f.followeeId === followeeId,
    )
    if (already) return Promise.resolve({ exists: true, created: false })
    this.follows.push({ followerId, followeeId })
    return Promise.resolve({ exists: true, created: true })
  }

  removeFollow(followerId: string, followeeId: string): Promise<{ exists: boolean }> {
    const target = this.users.get(followeeId)
    if (!target || target.deletedAt !== null) return Promise.resolve({ exists: false })
    const idx = this.follows.findIndex(
      (f) => f.followerId === followerId && f.followeeId === followeeId,
    )
    if (idx >= 0) this.follows.splice(idx, 1)
    return Promise.resolve({ exists: true })
  }

  followerCount(userId: string): Promise<number> {
    return Promise.resolve(this.follows.filter((f) => f.followeeId === userId).length)
  }

  pastEventsFor(userId: string, limit: number): Promise<CleanupRecord[]> {
    const mine = this.cleanups
      .filter((c) => c.record.organizerUserId === userId || c.attendees.has(userId))
      .map((c) => c.record)
      // Most recent first (scheduled_at DESC, id DESC) to mirror the Drizzle ordering.
      .sort((a, b) => {
        const cmp = b.scheduledAt.getTime() - a.scheduledAt.getTime()
        if (cmp !== 0) return cmp
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
      })
      .slice(0, limit)
    return Promise.resolve(mine)
  }

  statsFor(userId: string): Promise<ProfileStats> {
    const cleanups = this.cleanups.filter((c) => c.record.organizerUserId === userId).length
    return Promise.resolve({ reports: this.reportCounts.get(userId) ?? 0, cleanups })
  }
}

/** Parse a `${display_name}|${id}` keyset cursor (split on the LAST `|`). Mirrors the Drizzle impl. */
function parseNameCursor(cursor: string | null): { name: string; id: string } | null {
  if (cursor === null) return null
  const idx = cursor.lastIndexOf("|")
  if (idx < 0) return null
  const name = cursor.slice(0, idx)
  const id = cursor.slice(idx + 1)
  if (id.length === 0) return null
  return { name, id }
}

/**
 * A tiny CleanupRecord factory for seeding pastEvents. Defaults make a valid upcoming site cleanup whose
 * organizer is `organizerUserId`. Override any field for a specific test.
 */
export function makeCleanupRecord(over: Partial<CleanupRecord> & { organizerUserId: string }): CleanupRecord {
  const id = over.id ?? randomUUID()
  return {
    id,
    organizerUserId: over.organizerUserId,
    type: over.type ?? "site",
    eventKind: over.eventKind ?? "cleanup",
    title: over.title ?? "Beach cleanup",
    description: over.description ?? null,
    lat: over.lat ?? 34.0,
    lng: over.lng ?? -118.49,
    scheduledAt: over.scheduledAt ?? new Date("2025-01-01T10:00:00.000Z"),
    status: over.status ?? "done",
    bring: over.bring ?? null,
    address: over.address ?? null,
    jurisdictionGeoid: over.jurisdictionGeoid ?? null,
    referenceCode: over.referenceCode ?? null,
    createdAt: over.createdAt ?? new Date("2024-12-01T10:00:00.000Z"),
    going: over.going ?? 1,
    dist: over.dist ?? null,
    organizer: over.organizer ?? {
      id: over.organizerUserId,
      displayName: "Organizer",
      handle: null,
      bio: null,
    },
  }
}
