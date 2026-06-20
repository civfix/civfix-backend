/**
 * Admin users service (Phase 2): every neighbor and what they have contributed.
 *
 * Backs the users list (filter active/suspended/flagged + search name/handle/city, paginated), the
 * detail (profile + derived counts + trust/risk + role), the three paginated sub-activity lists
 * (their reports / cleanup memberships / chat messages), and the operator actions: flag/unflag,
 * set status (active|suspended|review|banned; a ban revokes ALL of the user's sessions), and set role
 * (citizen|gov_user|gov_admin|operator). See enumeration 2.F + endpoints #28-#35 and reconciliation 4.5.
 *
 * REPOSITORY SEAM: every read/write goes through AdminUserRepository (Drizzle impl in
 * admin-user-repository.drizzle.ts; an in-memory impl in admin-user-repository.memory.ts for the
 * offline unit tests). The session control (ban/clearBan/revokeAll) and the role write are SEPARATE
 * injected seams (SessionControl / SetUserRole) so the service stays free of the auth subsystem and the
 * in-memory tests can assert both were invoked without a real SessionService / UserStore.
 *
 * ENFORCEMENT (H2): a ban revokes ALL the user's sessions AND sets a banned marker (defense in depth, so
 * a missed revoke still cannot keep a banned account signed in); a revoke failure surfaces (the route
 * does NOT 200 on a failed ban). A role change revokes all the user's sessions too, so the role snapshot
 * cached on a live session cannot outlive the change (an operator demotion takes effect immediately, on
 * the victim's next request, via re-auth).
 *
 * DERIVED FIELDS (enumeration 4.5):
 *   - status: user_moderation.account_status, defaulting to "active" when no moderation row exists.
 *   - reports/cleanups: COUNTs over the user's reports / cleanup_members (not stored).
 *   - city: best-effort from the jurisdiction of the user's most recent report (no city column exists).
 *
 * AUDIT: flag/status/role mutations are audited inside the repo transaction (flag/status) or by the
 * service via the repo's recordAudit seam (role, which is written through the injected SetUserRole), all
 * with the operator userId the route resolves from request.auth.userId.
 */

import { AppError } from "@civfix/shared"
import type {
  AdminUserCounts,
  AdminUserDTO,
  AdminUserListItemDTO,
  AdminUserListQuery,
  AdminUserListResponse,
  Risk,
  Role,
  UserEventItemDTO,
  UserEventsResponse,
  UserMessageItemDTO,
  UserMessagesResponse,
  UserReportItemDTO,
  UserReportsResponse,
  UserStatus,
  UserSubListQuery,
  AdminReportStatus,
  ReportCategory,
} from "@civfix/shared"
import { toRelAbs } from "./admin-format.js"

// ---------------------------------------------------------------------------
// Repository seam (structural records; faked in tests)
// ---------------------------------------------------------------------------

/**
 * A user row joined with its moderation side table + the derived counts. `accountStatus` defaults to
 * "active" (the repo coalesces a missing user_moderation row). `city` is the best-effort location label.
 */
export interface AdminUserRecord {
  id: string
  name: string
  handle: string | null
  emailVerified: boolean
  hasOauth: boolean
  city: string
  role: Role
  joinedAt: Date | null
  lastActiveAt: Date | null
  accountStatus: UserStatus
  reports: number
  cleanups: number
  /** Count of the user's chat messages (the Messages tab badge); only computed on the detail read. */
  messages: number
  removals: number
  strikes: number
  risk: Risk
  flagged: boolean
  flagReason: string | null
  /** When the user self-deleted (tombstoned) their account; null for a live account. Admin keeps the
   *  real identity and only SEES the tombstone via this flag. */
  deletedAt: Date | null
}

/** A row in the user's Reports tab. */
export interface UserReportRecord {
  id: string
  category: ReportCategory
  title: string
  place: string
  status: AdminReportStatus
  createdAt: Date
}

/** A row in the user's Events tab (a cleanup they organized or joined). */
export interface UserEventRecord {
  id: string
  title: string
  place: string
  role: "organizer" | "member"
  attendees: number
  whenAt: Date
}

/** A row in the user's Messages tab (a chat message + the thread/cleanup it was in). */
export interface UserMessageRecord {
  id: string
  text: string
  thread: string
  createdAt: Date
  /** When the user themselves deleted (tombstoned) this message; null when not user-deleted. The admin
   *  still sees the original text, labeled via this flag. */
  deletedAt: Date | null
}

/** Normalized list arguments the repo consumes. `status` is the account status to match (null = any). */
export interface ListUsersArgs {
  q: string | null
  status: UserStatus | null
  flaggedOnly: boolean
  cursor: string | null
  limit: number
}

/**
 * Persistence seam for the admin users domain. The Drizzle impl runs raw SQL (aggregates + the
 * moderation upsert); the offline tests pass an in-memory impl.
 */
export interface AdminUserRepository {
  /** Page the users list applying the search / status / flagged facet, newest-first keyset paged. */
  listUsers(args: ListUsersArgs): Promise<{ records: AdminUserRecord[]; nextCursor: string | null }>
  /**
   * Per-facet account totals for the filter chips, over the SEARCHED (q) set — accurate + stable across
   * the facet instead of capped to the first keyset page.
   */
  countByFacet(args: { q: string | null }): Promise<AdminUserCounts>
  /** Load one user's full record (+ moderation + counts) by id, or null when absent. */
  getUser(id: string): Promise<AdminUserRecord | null>
  /** Page the user's own reports (newest first). */
  listUserReports(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: UserReportRecord[]; nextCursor: string | null }>
  /** Page the user's cleanup memberships (newest first). */
  listUserEvents(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: UserEventRecord[]; nextCursor: string | null }>
  /** Page the user's chat messages (newest first). */
  listUserMessages(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: UserMessageRecord[]; nextCursor: string | null }>
  /**
   * Toggle the user's flagged state (user_moderation.flagged + flag_reason) AND open/resolve an
   * abuse_flag (subject_type 'user'). Upserts the user_moderation row. Returns the resulting flagged
   * state, or null when the user does not exist.
   */
  toggleFlag(
    id: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<boolean | null>
  /**
   * Set the user's account status (upserts user_moderation.account_status). Returns false when the user
   * does not exist. Banning the user is handled by the service (it also revokes sessions); this only
   * persists the status + audits.
   */
  setStatus(
    id: string,
    input: { status: UserStatus; reason: string | null; actorId: string | null },
  ): Promise<boolean>
  /** Record a user.role_changed audit row (the role itself is written via the injected SetUserRole). */
  recordRoleAudit(id: string, input: { role: Role; actorId: string | null }): Promise<void>
  /**
   * Operator soft-delete (tombstone) of one of a user's chat messages, scoped to the user as the sender.
   * Audits "message.removed" in the same transaction. Returns true on success, false when the message does
   * not exist for that user (or was already removed). Distinct from the citizen self-delete: an operator
   * may remove ANY of the user's messages (not just their own), so it is keyed by (messageId, userId).
   */
  removeUserMessage(
    userId: string,
    messageId: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<boolean>
}

/**
 * Injected session-control seam (H2): the route wires this to SessionService. `ban` revokes all the
 * user's sessions AND sets the banned marker (defense in depth); `clearBan` lifts the marker on un-ban;
 * `revokeAll` revokes all sessions (used on a role change so a cached role snapshot cannot outlive the
 * change). Each returns the revoked count where applicable.
 */
export interface SessionControl {
  /** Revoke ALL the user's sessions (durable + cache) + set the banned marker. Returns revoked count. */
  ban(userId: string): Promise<number>
  /** Clear the user's banned marker (on un-ban). */
  clearBan(userId: string): Promise<void>
  /** Revoke ALL the user's sessions (no marker) - used on a role change. Returns revoked count. */
  revokeAll(userId: string): Promise<number>
}

/** Injected role-write seam (the route wires UserStore.setRole). Throws when the user does not exist. */
export type SetUserRole = (userId: string, role: Role) => Promise<void>

// ---------------------------------------------------------------------------
// Pure helpers (no DB, no IO)
// ---------------------------------------------------------------------------

/**
 * Map the list `filter` facet to a repo query shape. The design facet (all|active|suspended|flagged)
 * reconciles to: an account status to match and/or the flagged-only marker. "suspended" matches the
 * design's "any status other than active"; here it matches the explicit suspended status (the most
 * common non-active state); banned/review are reachable via the detail action, not a list facet.
 */
export function resolveUserFilter(filter: string | undefined): {
  status: UserStatus | null
  flaggedOnly: boolean
} {
  switch (filter) {
    case "active":
      return { status: "active", flaggedOnly: false }
    case "suspended":
      return { status: "suspended", flaggedOnly: false }
    case "flagged":
      return { status: null, flaggedOnly: true }
    default:
      return { status: null, flaggedOnly: false }
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AdminUserServiceDeps {
  repo: AdminUserRepository
  /** Session control (ban / clearBan / revokeAll) wired to SessionService (H2). */
  sessions: SessionControl
  /** Write the user's role (gov provisioning). */
  setUserRole: SetUserRole
  /** Injectable clock (defaults to () => new Date()). */
  now?: () => Date
}

/** Default page size for the user sub-activity lists. */
export const USER_SUBLIST_DEFAULT_LIMIT = 20

export interface AdminUserService {
  list(query: AdminUserListQuery): Promise<AdminUserListResponse>
  get(id: string): Promise<AdminUserDTO>
  getReports(query: UserSubListQuery): Promise<UserReportsResponse>
  getEvents(query: UserSubListQuery): Promise<UserEventsResponse>
  getMessages(query: UserSubListQuery): Promise<UserMessagesResponse>
  flag(id: string, input: { reason: string | null; actorId: string | null }): Promise<boolean>
  /** Set account status; on "banned" revoke all of the user's sessions. Returns the revoked count. */
  setStatus(
    id: string,
    input: { status: UserStatus; reason: string | null; actorId: string | null },
  ): Promise<{ revokedSessions: number }>
  setRole(id: string, input: { role: Role; actorId: string | null }): Promise<void>
  /** Operator removes (tombstones) one of a user's chat messages. 404 when the message does not exist. */
  removeMessage(
    userId: string,
    messageId: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<void>
}

export function makeAdminUserService(deps: AdminUserServiceDeps): AdminUserService {
  const now = deps.now ?? (() => new Date())

  /** Project a user record into the list-row DTO (shared by list + detail base). */
  function toListItem(record: AdminUserRecord, ref: Date): AdminUserListItemDTO {
    return {
      id: record.id,
      name: record.name,
      handle: record.handle ?? "",
      city: record.city,
      joined: record.joinedAt ? toRelAbs(record.joinedAt, ref).abs : "-",
      status: record.accountStatus,
      reports: record.reports,
      cleanups: record.cleanups,
      removals: record.removals,
      strikes: record.strikes,
      risk: record.risk,
      lastActive: record.lastActiveAt ? toRelAbs(record.lastActiveAt, ref).rel : "-",
      flagged: record.flagged,
      flagReason: record.flagReason,
      // Surface the tombstone so the admin UI can mark a self-deleted account (it still shows the real
      // name/handle/email — admins keep the truth). Additive + optional in the contract.
      deletedAt: record.deletedAt ? record.deletedAt.toISOString() : null,
    }
  }

  return {
    async list(query: AdminUserListQuery): Promise<AdminUserListResponse> {
      const ref = now()
      const { status, flaggedOnly } = resolveUserFilter(query.filter)
      const args: ListUsersArgs = {
        q: query.q && query.q.trim() !== "" ? query.q.trim() : null,
        status,
        flaggedOnly,
        cursor: query.cursor ?? null,
        limit: query.limit ?? 25,
      }
      // Counts span the searched set but ignore the facet, so the chips stay accurate as the operator
      // switches them (replaces the frontend's first-page-only client count).
      const [{ records, nextCursor }, counts] = await Promise.all([
        deps.repo.listUsers(args),
        deps.repo.countByFacet({ q: args.q }),
      ])
      return { items: records.map((r) => toListItem(r, ref)), nextCursor, counts }
    },

    async get(id: string): Promise<AdminUserDTO> {
      const ref = now()
      const record = await deps.repo.getUser(id)
      if (!record) throw AppError.notFound("User not found")
      return { ...toListItem(record, ref), role: record.role, messages: record.messages }
    },

    async getReports(query: UserSubListQuery): Promise<UserReportsResponse> {
      const ref = now()
      await assertUserExists(deps.repo, query.id)
      const { records, nextCursor } = await deps.repo.listUserReports(
        query.id,
        query.cursor ?? null,
        query.limit ?? USER_SUBLIST_DEFAULT_LIMIT,
      )
      const items: UserReportItemDTO[] = records.map((r) => ({
        id: r.id,
        category: r.category,
        title: r.title,
        place: r.place,
        status: r.status,
        age: toRelAbs(r.createdAt, ref).rel,
      }))
      return { items, nextCursor }
    },

    async getEvents(query: UserSubListQuery): Promise<UserEventsResponse> {
      const ref = now()
      await assertUserExists(deps.repo, query.id)
      const { records, nextCursor } = await deps.repo.listUserEvents(
        query.id,
        query.cursor ?? null,
        query.limit ?? USER_SUBLIST_DEFAULT_LIMIT,
      )
      const items: UserEventItemDTO[] = records.map((r) => ({
        id: r.id,
        title: r.title,
        place: r.place,
        role: r.role,
        attendees: r.attendees,
        when: toRelAbs(r.whenAt, ref).rel,
      }))
      return { items, nextCursor }
    },

    async getMessages(query: UserSubListQuery): Promise<UserMessagesResponse> {
      const ref = now()
      await assertUserExists(deps.repo, query.id)
      const { records, nextCursor } = await deps.repo.listUserMessages(
        query.id,
        query.cursor ?? null,
        query.limit ?? USER_SUBLIST_DEFAULT_LIMIT,
      )
      const items: UserMessageItemDTO[] = records.map((r) => ({
        id: r.id,
        text: r.text,
        thread: r.thread,
        when: toRelAbs(r.createdAt, ref).rel,
        // Surface a user-deleted message's tombstone so the admin UI can label it "[deleted by user]"
        // while still showing the original text. Additive + optional in the contract.
        deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
      }))
      return { items, nextCursor }
    },

    async flag(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<boolean> {
      const flagged = await deps.repo.toggleFlag(id, input)
      if (flagged === null) throw AppError.notFound("User not found")
      return flagged
    },

    async setStatus(
      id: string,
      input: { status: UserStatus; reason: string | null; actorId: string | null },
    ): Promise<{ revokedSessions: number }> {
      const ok = await deps.repo.setStatus(id, input)
      if (!ok) throw AppError.notFound("User not found")
      // H2: a ban revokes ALL of the user's sessions AND sets the banned marker (decisions 3.3 + defense
      // in depth). The revoke runs as part of this operation and its failure propagates (the route does
      // NOT 200 on a failed ban). Any OTHER status (active/suspended/review) lifts the ban marker so a
      // re-activated account is not vetoed by a stale marker; those statuses do not revoke live sessions.
      if (input.status === "banned") {
        const revokedSessions = await deps.sessions.ban(id)
        return { revokedSessions }
      }
      await deps.sessions.clearBan(id)
      return { revokedSessions: 0 }
    },

    async setRole(id: string, input: { role: Role; actorId: string | null }): Promise<void> {
      // Ensure the user exists first so a bad id is a clean 404 rather than a setRole throw.
      await assertUserExists(deps.repo, id)
      await deps.setUserRole(id, input.role)
      await deps.repo.recordRoleAudit(id, { role: input.role, actorId: input.actorId })
      // H2: revoke ALL the user's sessions so the role snapshot cached on a live session cannot outlive
      // the change (an operator demotion takes effect immediately; the victim must re-auth). Revoking on
      // every role change is the simplest correct policy and strictly safer than only-on-downgrade.
      await deps.sessions.revokeAll(id)
    },

    async removeMessage(
      userId: string,
      messageId: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<void> {
      const ok = await deps.repo.removeUserMessage(userId, messageId, input)
      if (!ok) throw AppError.notFound("Message not found")
    },
  }
}

/** Throw notFound when the user does not exist (shared by the sub-list + role paths). */
async function assertUserExists(repo: AdminUserRepository, id: string): Promise<void> {
  const user = await repo.getUser(id)
  if (!user) throw AppError.notFound("User not found")
}
