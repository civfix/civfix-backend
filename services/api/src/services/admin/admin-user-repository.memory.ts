/**
 * In-memory AdminUserRepository (Phase 2): the offline binding of the admin users persistence seam.
 *
 * Mirrors the Drizzle impl's OBSERVABLE contract so the admin user service can be unit-tested with NO
 * database (no Docker):
 *   - listUsers applies the search (name/handle/city) + the status + flagged-only facet and pages
 *     newest-id-keyset;
 *   - getUser reads the seeded user (+ moderation + counts);
 *   - listUserReports/Events/Messages page the seeded sub-activity rows;
 *   - toggleFlag flips user_moderation.flagged (+ records an audit); setStatus sets account_status (+
 *     audit); recordRoleAudit records the role-change audit.
 * Seed/inspect helpers (seedUser, seedReport/Event/Message, the public maps + audits) let tests arrange
 * + assert state directly. The session-revoke + setRole seams are injected into the SERVICE, not here.
 */

import { randomUUID } from "node:crypto"
import { clampLimit, decodeCursor, encodeCursor } from "./pagination.js"
import type {
  AdminUserRecord,
  AdminUserRepository,
  ListUsersArgs,
  UserEventRecord,
  UserMessageRecord,
  UserReportRecord,
} from "./admin-user-service.js"
import type { AdminUserCounts, Role, UserStatus } from "@civfix/shared"

/** A recorded audit row (mirrors the Drizzle impl's writeAudit), inspectable by tests. */
export interface RecordedUserAudit {
  action: string
  target: string
  meta: Record<string, unknown>
}

/** An in-memory AdminUserRepository faithful to the Drizzle impl's observable behavior. */
export class InMemoryAdminUserRepository implements AdminUserRepository {
  /** Seeded users keyed by id (insertion order preserved for stable paging). */
  readonly users = new Map<string, AdminUserRecord>()
  /** Seeded sub-activity rows keyed by user id. */
  readonly reports = new Map<string, UserReportRecord[]>()
  readonly events = new Map<string, UserEventRecord[]>()
  readonly messages = new Map<string, UserMessageRecord[]>()
  /** Recorded audit rows. */
  readonly audits: RecordedUserAudit[] = []

  /** Seed a user. Defaults fill the optional fields so a test only sets what it asserts on. */
  seedUser(input: {
    id?: string
    name?: string
    handle?: string | null
    emailVerified?: boolean
    hasOauth?: boolean
    city?: string
    role?: Role
    joinedAt?: Date | null
    lastActiveAt?: Date | null
    accountStatus?: UserStatus
    reports?: number
    cleanups?: number
    removals?: number
    strikes?: number
    risk?: AdminUserRecord["risk"]
    flagged?: boolean
    flagReason?: string | null
    verified?: boolean
    avatarUrl?: string | null
    deletedAt?: Date | null
  }): AdminUserRecord {
    const id = input.id ?? randomUUID()
    const record: AdminUserRecord = {
      id,
      name: input.name ?? "Neighbor",
      handle: input.handle ?? "neighbor",
      emailVerified: input.emailVerified ?? false,
      hasOauth: input.hasOauth ?? false,
      city: input.city ?? "",
      role: input.role ?? "citizen",
      joinedAt: input.joinedAt ?? null,
      lastActiveAt: input.lastActiveAt ?? null,
      accountStatus: input.accountStatus ?? "active",
      reports: input.reports ?? 0,
      cleanups: input.cleanups ?? 0,
      messages: 0, // recomputed from the seeded messages map in getUser (the detail's tab badge).
      removals: input.removals ?? 0,
      strikes: input.strikes ?? 0,
      risk: input.risk ?? "low",
      flagged: input.flagged ?? false,
      flagReason: input.flagReason ?? null,
      verified: input.verified ?? false,
      avatarUrl: input.avatarUrl ?? null,
      deletedAt: input.deletedAt ?? null,
    }
    this.users.set(id, record)
    return record
  }

  /** Seed a row in a user's Reports tab. */
  seedReport(userId: string, row: UserReportRecord): void {
    const list = this.reports.get(userId) ?? []
    list.push(row)
    this.reports.set(userId, list)
  }

  /** Seed a row in a user's Events tab. */
  seedEvent(userId: string, row: UserEventRecord): void {
    const list = this.events.get(userId) ?? []
    list.push(row)
    this.events.set(userId, list)
  }

  /** Seed a row in a user's Messages tab. `deletedAt` defaults to null (a live message). */
  seedMessage(
    userId: string,
    row: Omit<UserMessageRecord, "deletedAt"> & { deletedAt?: Date | null },
  ): void {
    const list = this.messages.get(userId) ?? []
    list.push({ ...row, deletedAt: row.deletedAt ?? null })
    this.messages.set(userId, list)
  }

  async listUsers(
    args: ListUsersArgs,
  ): Promise<{ records: AdminUserRecord[]; nextCursor: string | null }> {
    let rows = [...this.users.values()]

    if (args.q !== null) {
      const needle = args.q.toLowerCase()
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(needle) ||
          (r.handle?.toLowerCase().includes(needle) ?? false) ||
          r.city.toLowerCase().includes(needle),
      )
    }
    if (args.status !== null) rows = rows.filter((r) => r.accountStatus === args.status)
    if (args.flaggedOnly) rows = rows.filter((r) => r.flagged)

    // Newest-first by joinedAt, id desc tiebreak (a null join sorts oldest).
    rows.sort((a, b) => {
      const at = a.joinedAt?.getTime() ?? 0
      const bt = b.joinedAt?.getTime() ?? 0
      if (bt !== at) return bt - at
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    })

    const limit = clampLimit(args.limit)
    const anchor = decodeCursor(args.cursor)
    let start = 0
    if (anchor) {
      const idx = rows.findIndex((r) => r.id === anchor.id)
      start = idx >= 0 ? idx + 1 : rows.length
    }
    const slice = rows.slice(start, start + limit + 1)
    if (slice.length <= limit) {
      return { records: slice, nextCursor: null }
    }
    const records = slice.slice(0, limit)
    const last = records[records.length - 1]
    const nextCursor = last
      ? encodeCursor({ createdAt: last.joinedAt ?? new Date(0), id: last.id })
      : null
    return { records, nextCursor }
  }

  async getUser(id: string): Promise<AdminUserRecord | null> {
    const r = this.users.get(id)
    // Recompute the messages count from the seeded sub-activity (the detail's Messages tab badge), mirroring
    // the Drizzle COUNT(chat_messages) so a test that seeds messages sees the badge count.
    return r ? { ...r, messages: this.messages.get(id)?.length ?? 0 } : null
  }

  async countByFacet(args: { q: string | null }): Promise<AdminUserCounts> {
    let rows = [...this.users.values()]
    if (args.q !== null) {
      const needle = args.q.toLowerCase()
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(needle) ||
          (r.handle?.toLowerCase().includes(needle) ?? false) ||
          r.city.toLowerCase().includes(needle),
      )
    }
    let active = 0
    let suspended = 0
    let flagged = 0
    for (const r of rows) {
      if (r.accountStatus === "active") active += 1
      else if (r.accountStatus === "suspended") suspended += 1
      if (r.flagged) flagged += 1
    }
    return { all: rows.length, active, suspended, flagged }
  }

  async listUserReports(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: UserReportRecord[]; nextCursor: string | null }> {
    return pageSubList(
      [...(this.reports.get(id) ?? [])].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      ),
      cursor,
      limit,
      (r) => r.id,
    )
  }

  async listUserEvents(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: UserEventRecord[]; nextCursor: string | null }> {
    return pageSubList(
      [...(this.events.get(id) ?? [])].sort((a, b) => b.whenAt.getTime() - a.whenAt.getTime()),
      cursor,
      limit,
      (r) => r.id,
    )
  }

  async listUserMessages(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: UserMessageRecord[]; nextCursor: string | null }> {
    return pageSubList(
      [...(this.messages.get(id) ?? [])].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      ),
      cursor,
      limit,
      (r) => r.id,
    )
  }

  async toggleFlag(
    id: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<boolean | null> {
    const r = this.users.get(id)
    if (!r) return null
    const next = !r.flagged
    r.flagged = next
    r.flagReason = next ? input.reason : null
    this.audits.push({
      action: next ? "user.flagged" : "user.unflagged",
      target: `user:${id}`,
      meta: { reason: input.reason },
    })
    return next
  }

  async setStatus(
    id: string,
    input: { status: UserStatus; reason: string | null; actorId: string | null },
  ): Promise<boolean> {
    const r = this.users.get(id)
    if (!r) return false
    r.accountStatus = input.status
    this.audits.push({
      // A ban gets the dedicated user.banned action; other transitions are user.status_changed.
      action: input.status === "banned" ? "user.banned" : "user.status_changed",
      target: `user:${id}`,
      meta: { status: input.status, reason: input.reason },
    })
    return true
  }

  async recordRoleAudit(id: string, input: { role: Role; actorId: string | null }): Promise<void> {
    this.audits.push({
      action: "user.role_changed",
      target: `user:${id}`,
      meta: { role: input.role },
    })
  }

  async setVerified(
    id: string,
    input: { verified: boolean; actorId: string | null },
  ): Promise<boolean> {
    const r = this.users.get(id)
    if (!r) return false
    r.verified = input.verified
    this.audits.push({
      action: input.verified ? "user.verified" : "user.unverified",
      target: `user:${id}`,
      meta: {},
    })
    return true
  }

  async removeUserMessage(
    userId: string,
    messageId: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<boolean> {
    const list = this.messages.get(userId)
    const found = list?.find((m) => m.id === messageId && m.deletedAt === null)
    if (!found) return false
    found.deletedAt = new Date()
    this.audits.push({
      action: "message.removed",
      target: `message:${messageId}`,
      meta: { userId, reason: input.reason },
    })
    return true
  }
}

/** Page a pre-sorted sub-list by the shared "<iso>|<id>" id-keyset cursor (one-extra-row probe). */
function pageSubList<T>(
  rows: T[],
  cursor: string | null,
  limit: number,
  idOf: (row: T) => string,
): { records: T[]; nextCursor: string | null } {
  const lim = clampLimit(limit)
  const anchor = decodeCursor(cursor)
  let start = 0
  if (anchor) {
    const idx = rows.findIndex((r) => idOf(r) === anchor.id)
    start = idx >= 0 ? idx + 1 : rows.length
  }
  const slice = rows.slice(start, start + lim + 1)
  if (slice.length <= lim) {
    return { records: slice, nextCursor: null }
  }
  const records = slice.slice(0, lim)
  const last = records[records.length - 1]
  const nextCursor = last ? encodeCursor({ createdAt: new Date(0), id: idOf(last) }) : null
  return { records, nextCursor }
}
