import { randomUUID } from "node:crypto"
import { pageInMemoryById } from "../../../src/services/admin/pagination.js"
import type {
  AdminUserOrganizationRecord,
  AdminUserRecord,
  AdminUserRepository,
  ListUsersArgs,
  UserEventRecord,
  UserMessageRecord,
  UserReportRecord,
} from "../../../src/services/admin/admin-user-repository.js"
import type { AdminUserCounts, Role, UserStatus } from "@civfix/shared"

export interface RecordedUserAudit {
  action: string
  target: string
  meta: Record<string, unknown>
}

function appendTo<T>(map: Map<string, T[]>, key: string, row: T): void {
  const list = map.get(key) ?? []
  list.push(row)
  map.set(key, list)
}

function userSearchMatcher(q: string): (record: AdminUserRecord) => boolean {
  const needle = q.toLowerCase()
  return (r) =>
    r.name.toLowerCase().includes(needle) ||
    (r.handle?.toLowerCase().includes(needle) ?? false) ||
    r.city.toLowerCase().includes(needle)
}

export class InMemoryAdminUserRepository implements AdminUserRepository {
  readonly users = new Map<string, AdminUserRecord>()
  readonly reports = new Map<string, UserReportRecord[]>()
  readonly events = new Map<string, UserEventRecord[]>()
  readonly messages = new Map<string, UserMessageRecord[]>()
  readonly organizations = new Map<string, AdminUserOrganizationRecord[]>()
  readonly audits: RecordedUserAudit[] = []

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
    reportVerified?: boolean
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
      messages: 0, // recomputed from the seeded messages in getUser
      removals: input.removals ?? 0,
      strikes: input.strikes ?? 0,
      risk: input.risk ?? "low",
      flagged: input.flagged ?? false,
      flagReason: input.flagReason ?? null,
      reportVerified: input.reportVerified ?? false,
      avatarUrl: input.avatarUrl ?? null,
      deletedAt: input.deletedAt ?? null,
    }
    this.users.set(id, record)
    return record
  }

  seedReport(userId: string, row: UserReportRecord): void {
    appendTo(this.reports, userId, row)
  }

  seedEvent(userId: string, row: UserEventRecord): void {
    appendTo(this.events, userId, row)
  }

  seedMessage(
    userId: string,
    row: Omit<UserMessageRecord, "deletedAt" | "source" | "sourceId"> & {
      deletedAt?: Date | null
      source?: UserMessageRecord["source"]
      sourceId?: string | null
    },
  ): void {
    appendTo(this.messages, userId, {
      ...row,
      deletedAt: row.deletedAt ?? null,
      source: row.source ?? "chat",
      sourceId: row.sourceId ?? null,
    })
  }

  async listUsers(
    args: ListUsersArgs,
  ): Promise<{ records: AdminUserRecord[]; nextCursor: string | null }> {
    let rows = [...this.users.values()]

    if (args.q !== null) rows = rows.filter(userSearchMatcher(args.q))
    if (args.status !== null) rows = rows.filter((r) => r.accountStatus === args.status)
    if (args.flaggedOnly) rows = rows.filter((r) => r.flagged)
    if (args.deletedOnly) rows = rows.filter((r) => r.deletedAt !== null)

    // A null join sorts oldest.
    rows.sort((a, b) => {
      const at = a.joinedAt?.getTime() ?? 0
      const bt = b.joinedAt?.getTime() ?? 0
      if (bt !== at) return bt - at
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    })

    return pageInMemoryById(rows, args.cursor, args.limit, (r) => ({
      at: r.joinedAt ?? new Date(0),
      id: r.id,
    }))
  }

  async userExists(id: string): Promise<boolean> {
    // A soft-deleted account still exists for the console (list and detail render it with deletedAt set),
    // so its sub-activity tabs must keep resolving.
    return this.users.has(id)
  }

  async getUser(id: string): Promise<AdminUserRecord | null> {
    const r = this.users.get(id)
    // Mirrors the Drizzle COUNT(chat_messages) so a test that seeds messages sees the badge count.
    return r ? { ...r, messages: this.messages.get(id)?.length ?? 0 } : null
  }

  async countByFacet(args: { q: string | null }): Promise<AdminUserCounts> {
    let rows = [...this.users.values()]
    if (args.q !== null) rows = rows.filter(userSearchMatcher(args.q))
    let active = 0
    let suspended = 0
    let flagged = 0
    let deleted = 0
    let banned = 0
    for (const r of rows) {
      if (r.accountStatus === "active") active += 1
      else if (r.accountStatus === "suspended") suspended += 1
      if (r.flagged) flagged += 1
      if (r.deletedAt !== null) deleted += 1
      if (r.accountStatus === "banned") banned += 1
    }
    return { all: rows.length, active, suspended, flagged, deleted, banned }
  }

  async listUserReports(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: UserReportRecord[]; nextCursor: string | null }> {
    return pageInMemoryById(
      [...(this.reports.get(id) ?? [])].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      ),
      cursor,
      limit,
      (r) => ({ at: r.createdAt, id: r.id }),
    )
  }

  async listUserEvents(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: UserEventRecord[]; nextCursor: string | null }> {
    return pageInMemoryById(
      [...(this.events.get(id) ?? [])].sort((a, b) => b.whenAt.getTime() - a.whenAt.getTime()),
      cursor,
      limit,
      (r) => ({ at: r.whenAt, id: r.id }),
    )
  }

  async listUserMessages(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: UserMessageRecord[]; nextCursor: string | null }> {
    return pageInMemoryById(
      [...(this.messages.get(id) ?? [])].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      ),
      cursor,
      limit,
      (r) => ({ at: r.createdAt, id: r.id }),
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
      action: input.status === "banned" ? "user.banned" : "user.status_changed",
      target: `user:${id}`,
      meta: { status: input.status, reason: input.reason },
    })
    return true
  }

  /** The role write and its audit are one indivisible step, as in the Drizzle impl's transaction. */
  async applyRole(id: string, input: { role: Role; actorId: string | null }): Promise<boolean> {
    const r = this.users.get(id)
    if (!r) return false
    const priorRole = r.role
    r.role = input.role
    this.audits.push({
      action: "user.role_changed",
      target: `user:${id}`,
      meta: { role: input.role, priorRole },
    })
    return true
  }

  listUserOrganizations(id: string): Promise<AdminUserOrganizationRecord[]> {
    return Promise.resolve([...(this.organizations.get(id) ?? [])])
  }

  seedUserOrganizations(userId: string, orgs: AdminUserOrganizationRecord[]): void {
    this.organizations.set(userId, orgs)
  }

  async setReportVerified(
    id: string,
    input: { value: boolean; actorId: string | null },
  ): Promise<boolean> {
    const r = this.users.get(id)
    if (!r) return false
    r.reportVerified = input.value
    this.audits.push({
      action: input.value ? "user.report_verified" : "user.report_unverified",
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
