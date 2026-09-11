
import { randomUUID } from "node:crypto"
import type {
  PersonView,
  ProfileEventsPage,
  ProfileEventsPageArgs,
  ProfileStats,
  SocialRepository,
  UpcomingEventsArgs,
} from "../../src/services/social-service.js"
import type { CleanupRecord } from "../../src/services/cleanup-service.js"
import { encodeTimeCursor, pageWith, parseTimeCursor } from "../../src/db/cursor-helpers.js"
import {
  SUGGEST_CANDIDATE_POOL,
  SUGGEST_CANDIDATE_RADIUS_DEG,
} from "../../src/services/social-repository.drizzle.js"

interface StoredUser {
  id: string
  displayName: string
  handle: string | null
  bio: string | null
  deletedAt: Date | null
  avatarUrl?: string | null
  showVolunteerHours?: boolean | null
}

interface StoredFollow {
  followerId: string
  followeeId: string
}

interface StoredCleanup {
  record: CleanupRecord
  attendees: Set<string>
}

export class InMemorySocialRepository implements SocialRepository {
  readonly users = new Map<string, StoredUser>()
  readonly follows: StoredFollow[] = []
  readonly cleanups: StoredCleanup[] = []
  readonly reportCounts = new Map<string, number>()
  readonly fixedReportCounts = new Map<string, number>()
  readonly followerCounts = new Map<string, number>()
  readonly followingCounts = new Map<string, number>()

  seedUser(over: Partial<StoredUser> = {}): StoredUser {
    const user: StoredUser = {
      id: over.id ?? randomUUID(),
      displayName: over.displayName ?? "Person",
      handle: over.handle ?? null,
      bio: over.bio ?? null,
      deletedAt: over.deletedAt ?? null,
      showVolunteerHours: over.showVolunteerHours ?? null,
      ...(over.avatarUrl !== undefined ? { avatarUrl: over.avatarUrl } : {}),
    }
    this.users.set(user.id, user)
    return user
  }

  seedFollow(followerId: string, followeeId: string): void {
    if (!this.follows.some((f) => f.followerId === followerId && f.followeeId === followeeId)) {
      this.follows.push({ followerId, followeeId })
      this.bumpCounters(followerId, followeeId, 1)
    }
  }

  private bumpCounters(followerId: string, followeeId: string, delta: number): void {
    this.followerCounts.set(followeeId, Math.max((this.followerCounts.get(followeeId) ?? 0) + delta, 0))
    this.followingCounts.set(followerId, Math.max((this.followingCounts.get(followerId) ?? 0) + delta, 0))
  }

  seedCleanup(record: CleanupRecord, attendees: string[] = []): void {
    const set = new Set<string>(attendees)
    set.add(record.organizerUserId)
    this.cleanups.push({ record, attendees: set })
  }

  seedReports(userId: string, count: number, fixed = 0): void {
    this.reportCounts.set(userId, count)
    this.fixedReportCounts.set(userId, fixed)
  }

  private toView(u: StoredUser): PersonView {
    return {
      id: u.id,
      displayName: u.displayName,
      handle: u.handle,
      bio: u.bio,
      followers: this.followerCounts.get(u.id) ?? 0,
      following: this.followingCounts.get(u.id) ?? 0,
      avatarR2Key: null,
      avatarUrl: u.avatarUrl ?? null,
      socialLinks: null,
      showVolunteerHours: u.showVolunteerHours ?? null,
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
      if (args.viewerId !== null && this.isBlockedEitherWay(args.viewerId, u.id)) return false
      if (q !== null) {
        const inHandle = u.handle !== null && u.handle.toLowerCase().includes(q)
        const inName = u.displayName.toLowerCase().includes(q)
        if (!inHandle && !inName) return false
      }
      return true
    })

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

  readonly blockedPairs: Array<{ a: string; b: string }> = []

  seedBlock(a: string, b: string): void {
    this.blockedPairs.push({ a, b })
  }

  private isBlockedEitherWay(viewerId: string, otherId: string): boolean {
    return this.blockedPairs.some(
      (p) => (p.a === viewerId && p.b === otherId) || (p.a === otherId && p.b === viewerId),
    )
  }

  private activityPoint(userId: string, organizedOnly: boolean): { lat: number; lng: number } | null {
    const mine = this.cleanups
      .filter((c) =>
        organizedOnly
          ? c.record.organizerUserId === userId
          : c.record.organizerUserId === userId || c.attendees.has(userId),
      )
      .sort((a, b) => b.record.createdAt.getTime() - a.record.createdAt.getTime())
    const rec = mine[0]?.record
    return rec ? { lat: rec.lat, lng: rec.lng } : null
  }

  private activityAt(userId: string): Date | null {
    const mine = this.cleanups
      .filter((c) => c.record.organizerUserId === userId)
      .sort((a, b) => b.record.createdAt.getTime() - a.record.createdAt.getTime())
    return mine[0]?.record.createdAt ?? null
  }

  private isOrganizer(userId: string): boolean {
    return this.cleanups.some((c) => c.record.organizerUserId === userId)
  }

  suggestFollows(args: {
    viewerId: string
    limit: number
  }): Promise<Array<PersonView & { isFollowing: boolean }>> {
    const NEARBY_METERS = 25_000
    const RADIUS_METERS = SUGGEST_CANDIDATE_RADIUS_DEG * 111_320
    const viewerPoint = this.activityPoint(args.viewerId, false)
    const haversine = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number => {
      const toRad = (d: number): number => (d * Math.PI) / 180
      const dLat = toRad(b.lat - a.lat)
      const dLng = toRad(b.lng - a.lng)
      const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
      return 2 * 6371000 * Math.asin(Math.sqrt(s))
    }
    const eligible = [...this.users.values()].filter((u) => {
      if (u.deletedAt !== null || u.handle === null || u.id === args.viewerId) return false
      if (this.follows.some((f) => f.followerId === args.viewerId && f.followeeId === u.id)) {
        return false
      }
      if (this.isBlockedEitherWay(args.viewerId, u.id)) return false
      return true
    })
    const scored = eligible.map((u) => {
      const point = this.activityPoint(u.id, true)
      const meters = viewerPoint && point ? haversine(viewerPoint, point) : null
      return {
        u,
        point,
        at: this.activityAt(u.id),
        meters,
        near: meters !== null && meters <= NEARBY_METERS,
        organizer: this.isOrganizer(u.id),
      }
    })
    const nearPool =
      viewerPoint === null
        ? []
        : scored
            .filter((c) => c.point !== null && c.meters !== null && c.meters <= RADIUS_METERS)
            .sort((a, b) => (a.meters ?? 0) - (b.meters ?? 0))
            .slice(0, SUGGEST_CANDIDATE_POOL)
    const recentPool = scored
      .filter((c) => c.at !== null)
      .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))
      .slice(0, SUGGEST_CANDIDATE_POOL)
    const newPool = [...scored].reverse().slice(0, SUGGEST_CANDIDATE_POOL)
    const pool = new Map<string, (typeof scored)[number]>()
    for (const c of [...nearPool, ...recentPool, ...newPool]) pool.set(c.u.id, c)

    const ranked = [...pool.values()]
      .sort((a, b) => {
        const tier = (c: (typeof scored)[number]): number =>
          c.near && c.organizer ? 0 : c.near ? 1 : c.organizer ? 2 : 3
        if (tier(a) !== tier(b)) return tier(a) - tier(b)
        const da = a.meters ?? Number.POSITIVE_INFINITY
        const db = b.meters ?? Number.POSITIVE_INFINITY
        if (da !== db) return da - db
        const fa = this.followerCounts.get(a.u.id) ?? 0
        const fb = this.followerCounts.get(b.u.id) ?? 0
        return fb - fa
      })
      .slice(0, args.limit)
    return Promise.resolve(ranked.map((c) => ({ ...this.toView(c.u), isFollowing: false })))
  }

  listFollowers(args: {
    id: string
    viewerId: string | null
    cursor: string | null
    limit: number
  }): Promise<{ items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null }> {
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
    const followeeIds = new Set(
      this.follows.filter((f) => f.followerId === args.id).map((f) => f.followeeId),
    )
    return this.connectionsPage(followeeIds, args)
  }

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
    this.bumpCounters(followerId, followeeId, 1)
    return Promise.resolve({ exists: true, created: true })
  }

  removeFollow(followerId: string, followeeId: string): Promise<{ exists: boolean }> {
    const target = this.users.get(followeeId)
    if (!target || target.deletedAt !== null) return Promise.resolve({ exists: false })
    const idx = this.follows.findIndex(
      (f) => f.followerId === followerId && f.followeeId === followeeId,
    )
    if (idx >= 0) {
      this.follows.splice(idx, 1)
      this.bumpCounters(followerId, followeeId, -1)
    }
    return Promise.resolve({ exists: true })
  }

  followerCount(userId: string): Promise<number> {
    return Promise.resolve(this.followerCounts.get(userId) ?? 0)
  }

  pastEventsPageFor(userId: string, args: ProfileEventsPageArgs): Promise<ProfileEventsPage> {
    const now = Date.now()
    const all = this.cleanups
      .filter((c) => c.record.organizerUserId === userId || c.attendees.has(userId))
      .map((c) => c.record)
      .filter((r) => r.scheduledAt.getTime() < now && r.status !== "cancelled")
      .sort((a, b) => {
        const cmp = b.scheduledAt.getTime() - a.scheduledAt.getTime()
        if (cmp !== 0) return cmp
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
      })
    const cursor = parseTimeCursor(args.cursor)
    const after =
      cursor !== null
        ? all.filter((r) => {
            const cmp = r.scheduledAt.getTime() - cursor.at.getTime()
            return cmp !== 0 ? cmp < 0 : r.id < cursor.id
          })
        : all
    const { items, nextCursor } = pageWith(after, args.limit, (last) =>
      encodeTimeCursor({ at: last.scheduledAt, id: last.id }),
    )
    return Promise.resolve({ items, nextCursor })
  }

  upcomingEventsFor(userId: string, args: UpcomingEventsArgs): Promise<CleanupRecord[]> {
    const now = Date.now()
    const mine = this.cleanups
      .filter(
        (c) =>
          c.record.organizerUserId === userId ||
          (args.includeAttending && c.attendees.has(userId)),
      )
      .map((c) => c.record)
      .filter((r) => r.scheduledAt.getTime() >= now && r.status !== "cancelled")
      .sort((a, b) => {
        const cmp = a.scheduledAt.getTime() - b.scheduledAt.getTime()
        if (cmp !== 0) return cmp
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      .slice(0, args.limit)
    return Promise.resolve(mine)
  }

  statsFor(userId: string): Promise<ProfileStats> {
    const cleanups = this.cleanups.filter((c) => c.record.organizerUserId === userId).length
    return Promise.resolve({
      reports: this.reportCounts.get(userId) ?? 0,
      fixed: this.fixedReportCounts.get(userId) ?? 0,
      cleanups,
    })
  }
}

function parseNameCursor(cursor: string | null): { name: string; id: string } | null {
  if (cursor === null) return null
  const idx = cursor.lastIndexOf("|")
  if (idx < 0) return null
  const name = cursor.slice(0, idx)
  const id = cursor.slice(idx + 1)
  if (id.length === 0) return null
  return { name, id }
}

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
    completedAt: over.completedAt ?? null,
    status: over.status ?? "done",
    bring: over.bring ?? null,
    address: over.address ?? null,
    jurisdictionGeoid: over.jurisdictionGeoid ?? null,
    referenceCode: over.referenceCode ?? null,
    createdAt: over.createdAt ?? new Date("2024-12-01T10:00:00.000Z"),
    capacity: over.capacity ?? null,
    going: over.going ?? 1,
    dist: over.dist ?? null,
    organizer: over.organizer ?? {
      id: over.organizerUserId,
      displayName: "Organizer",
      handle: null,
      bio: null,
    },
    endsAt: over.endsAt ?? null,
    timezone: over.timezone ?? null,
    visibility: over.visibility ?? "public",
    coverMediaId: over.coverMediaId ?? null,
    coverKey: over.coverKey ?? null,
    galleryMediaIds: over.galleryMediaIds ?? [],
    donationUrl: over.donationUrl ?? null,
    pageSlug: over.pageSlug ?? null,
    registrationOpensAt: over.registrationOpensAt ?? null,
    registrationClosesAt: over.registrationClosesAt ?? null,
    organizationId: over.organizationId ?? null,
    organization: over.organization ?? null,
    reminderOffsetsMin: over.reminderOffsetsMin ?? null,
    hostReplyTo: over.hostReplyTo ?? null,
    hostReplyToVerifiedAt: over.hostReplyToVerifiedAt ?? null,
  }
}
