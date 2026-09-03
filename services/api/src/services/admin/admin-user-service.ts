
import { AppError, avatarGradient } from "@civfix/shared"
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
  CleanupMemberRole,
} from "@civfix/shared"
import { toRelAbs } from "./admin-format.js"
import { applyRoleChange } from "./role-change.js"

export interface AdminUserRecord {
  id: string
  name: string
  handle: string | null
  emailVerified?: boolean
  hasOauth?: boolean
  city: string
  role: Role
  joinedAt: Date | null
  lastActiveAt: Date | null
  accountStatus: UserStatus
  reports: number
  cleanups: number
  messages: number
  removals: number
  strikes: number
  risk: Risk
  flagged: boolean
  flagReason: string | null
  verified: boolean
  reportVerified: boolean
  avatarUrl: string | null
  deletedAt: Date | null
}

export interface UserReportRecord {
  id: string
  category: ReportCategory
  title: string
  place: string
  status: AdminReportStatus
  createdAt: Date
}

export interface UserEventRecord {
  id: string
  title: string
  place: string
  role: CleanupMemberRole
  attendees: number
  whenAt: Date
}

export interface UserMessageRecord {
  id: string
  text: string
  thread: string
  createdAt: Date
  deletedAt: Date | null
  source: "chat" | "group" | "dm" | "report"
  /**
   * The origin entity id: event/cleanup for `chat`, standalone group for `group`, report for `report`,
   * and null for DMs. A group id is not an event id, and the admin has no group detail surface yet.
   */
  sourceId: string | null
}

export interface ListUsersArgs {
  q: string | null
  status: UserStatus | null
  flaggedOnly: boolean
  cursor: string | null
  limit: number
}

export interface AdminUserRepository {
  listUsers(args: ListUsersArgs): Promise<{ records: AdminUserRecord[]; nextCursor: string | null }>
  countByFacet(args: { q: string | null }): Promise<AdminUserCounts>
  /**
   * Cheap existence probe for the sub-list 404 guard. `getUser` is the heaviest read in this repo (message
   * COUNT(*)s across chat_messages + dm_messages, report/cleanup counts, the city subquery, a verification
   * EXISTS) and ran before EVERY reports/events/messages page just to decide whether to 404. Reach matches
   * getUser's — a soft-deleted account still exists for the console.
   */
  userExists(id: string): Promise<boolean>
  getUser(id: string): Promise<AdminUserRecord | null>
  listUserReports(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: UserReportRecord[]; nextCursor: string | null }>
  listUserEvents(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: UserEventRecord[]; nextCursor: string | null }>
  listUserMessages(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: UserMessageRecord[]; nextCursor: string | null }>
  toggleFlag(
    id: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<boolean | null>
  setStatus(
    id: string,
    input: { status: UserStatus; reason: string | null; actorId: string | null },
  ): Promise<boolean>
  /**
   * L5: write `users.role` AND its `user.role_changed` audit row in ONE transaction, so a committed
   * privilege change can never end up unaudited. Returns false when the user does not exist.
   * (This REPLACES the old pair of a `setUserRole` seam write + a separate `recordRoleAudit` call, which
   * went through two independent connections.)
   */
  applyRole(id: string, input: { role: Role; actorId: string | null }): Promise<boolean>
  setVerified(
    id: string,
    input: { verified: boolean; actorId: string | null },
  ): Promise<boolean>
  setReportVerified(
    id: string,
    input: { value: boolean; actorId: string | null },
  ): Promise<boolean>
  removeUserMessage(
    userId: string,
    messageId: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<boolean>
}

export interface SessionControl {
  applyStatus(userId: string, status: UserStatus): Promise<number>
  revokeAll(userId: string): Promise<number>
}

/**
 * H3: roles this endpoint may GRANT. `operator` is deliberately absent.
 *
 * Operator authority derives from exactly two things: membership in `env.ADMIN_EMAILS` and the Cloudflare
 * Access exchange that provisions the row (routes/admin/auth.routes.ts). Before this guard, ONE operator
 * (or one phished operator session, or the world-readable reviewer-OTP credential chained into an operator
 * session) could POST /admin/users/:id/role {role:"operator"} and mint a PERMANENT backdoor account that
 * no allowlist change could revoke. Granting operator through the console is therefore refused outright:
 * to add an operator, add the address to ADMIN_EMAILS and have them sign in through Cloudflare Access.
 */
const GRANTABLE_ROLES: ReadonlySet<Role> = new Set<Role>(["citizen", "gov_user", "gov_admin"])

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

export interface AdminUserServiceDeps {
  repo: AdminUserRepository
  sessions: SessionControl
  now?: () => Date
}

export const USER_SUBLIST_DEFAULT_LIMIT = 20

export interface AdminUserService {
  list(query: AdminUserListQuery): Promise<AdminUserListResponse>
  get(id: string): Promise<AdminUserDTO>
  getReports(query: UserSubListQuery): Promise<UserReportsResponse>
  getEvents(query: UserSubListQuery): Promise<UserEventsResponse>
  getMessages(query: UserSubListQuery): Promise<UserMessagesResponse>
  flag(id: string, input: { reason: string | null; actorId: string | null }): Promise<boolean>
  setStatus(
    id: string,
    input: { status: UserStatus; reason: string | null; actorId: string | null },
  ): Promise<{ revokedSessions: number }>
  setRole(id: string, input: { role: Role; actorId: string | null }): Promise<void>
  setVerified(id: string, input: { verified: boolean; actorId: string | null }): Promise<void>
  setReportVerified(id: string, input: { value: boolean; actorId: string | null }): Promise<void>
  removeMessage(
    userId: string,
    messageId: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<void>
}

export function makeAdminUserService(deps: AdminUserServiceDeps): AdminUserService {
  const now = deps.now ?? (() => new Date())

  function toListItem(record: AdminUserRecord, ref: Date): AdminUserListItemDTO {
    return {
      id: record.id,
      name: record.name,
      handle: record.handle ?? "",
      city: record.city,
      joined: record.joinedAt ? toRelAbs(record.joinedAt, ref).abs : "-",
      avatar: avatarGradient(record.id),
      ...(record.avatarUrl !== null ? { avatarUrl: record.avatarUrl } : {}),
      status: record.accountStatus,
      reports: record.reports,
      cleanups: record.cleanups,
      removals: record.removals,
      strikes: record.strikes,
      risk: record.risk,
      lastActive: record.lastActiveAt ? toRelAbs(record.lastActiveAt, ref).rel : "-",
      flagged: record.flagged,
      flagReason: record.flagReason,
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
      const [{ records, nextCursor }, counts] = await Promise.all([
        deps.repo.listUsers(args),
        args.cursor === null
          ? deps.repo.countByFacet({ q: args.q })
          : Promise.resolve<AdminUserCounts>({ all: 0, active: 0, suspended: 0, flagged: 0 }),
      ])
      return { items: records.map((r) => toListItem(r, ref)), nextCursor, counts }
    },

    async get(id: string): Promise<AdminUserDTO> {
      const ref = now()
      const record = await deps.repo.getUser(id)
      if (!record) throw AppError.notFound("User not found")
      return {
        ...toListItem(record, ref),
        role: record.role,
        messages: record.messages,
        verificationStatus: record.verified ? "verified" : "unverified",
        reportVerified: record.reportVerified,
      }
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
        deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
        source: r.source,
        sourceId: r.sourceId,
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
      // H3: an operator must not be bannable from this endpoint. Without this, one operator (or one phished
      // operator session) could ban every OTHER operator and be left alone in the console. Operator
      // off-boarding is an ADMIN_EMAILS edit, not a console ban.
      await assertTargetIsNotOperator(deps.repo, id, "ban or change the status of")
      const ok = await deps.repo.setStatus(id, input)
      if (!ok) throw AppError.notFound("User not found")
      const revokedSessions = await deps.sessions.applyStatus(id, input.status)
      return { revokedSessions }
    },

    async setRole(id: string, input: { role: Role; actorId: string | null }): Promise<void> {
      // --- H3 authorization guards, ALL evaluated before any write. ---

      // (1) `operator` may never be granted here. It derives from ADMIN_EMAILS + the Cloudflare Access
      //     exchange only; a console-granted operator would be a permanent backdoor no allowlist edit
      //     could revoke. See GRANTABLE_ROLES.
      if (!GRANTABLE_ROLES.has(input.role)) {
        throw AppError.forbidden(
          "Operator access is granted only through ADMIN_EMAILS and Cloudflare Access, not this endpoint.",
        )
      }
      // (2) No self-targeting. A role change revokes every session of the target, so an operator changing
      //     their OWN role locks themselves out mid-flight; more importantly it is the shape a confused-
      //     deputy/CSRF chain takes (make the phished operator demote themselves, or escalate a session
      //     they already hold). Role changes are always about somebody else.
      if (input.actorId !== null && input.actorId === id) {
        throw AppError.forbidden("You cannot change your own role.")
      }
      const target = await deps.repo.getUser(id)
      if (!target) throw AppError.notFound("User not found")
      // (3) An existing operator is not demotable here either — otherwise one operator could strip every
      //     other operator and hold the console alone. Demote by removing the address from ADMIN_EMAILS
      //     (auth/admin-guard.ts re-checks it on every admin request, so access ends within the cache TTL).
      if (target.role === "operator") {
        throw AppError.forbidden(
          "Operator accounts are managed through ADMIN_EMAILS; they cannot be changed from the console.",
        )
      }

      // M4: the ONE role-change path (role-change.ts) — write, then revoke every live session, in that
      // order. H2 is the reason the revoke is not optional: the OLD role is baked into every warm Redis
      // session projection, and sliding expiry means an actively-used session never expires on its own.
      // L5: the role UPDATE and its user.role_changed audit are ONE transaction inside `write`, so a
      // committed privilege change can never be missing its audit row.
      await applyRoleChange(
        {
          write: async (userId, role) => {
            const ok = await deps.repo.applyRole(userId, { role, actorId: input.actorId })
            if (!ok) throw AppError.notFound("User not found")
          },
          revokeAll: deps.sessions.revokeAll.bind(deps.sessions),
        },
        id,
        input.role,
      )
    },

    async setVerified(
      id: string,
      input: { verified: boolean; actorId: string | null },
    ): Promise<void> {
      const ok = await deps.repo.setVerified(id, input)
      if (!ok) throw AppError.notFound("User not found")
    },

    async setReportVerified(
      id: string,
      input: { value: boolean; actorId: string | null },
    ): Promise<void> {
      const ok = await deps.repo.setReportVerified(id, input)
      if (!ok) throw AppError.notFound("User not found")
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

async function assertUserExists(repo: AdminUserRepository, id: string): Promise<void> {
  if (!(await repo.userExists(id))) throw AppError.notFound("User not found")
}

/**
 * H3: refuse a privileged mutation whose TARGET is currently an operator. Operator accounts are governed
 * by ADMIN_EMAILS + the Cloudflare Access exchange; letting one operator ban or demote another turns a
 * single compromised operator session into a full takeover of the console.
 */
async function assertTargetIsNotOperator(
  repo: AdminUserRepository,
  id: string,
  verb: string,
): Promise<void> {
  const target = await repo.getUser(id)
  if (!target) throw AppError.notFound("User not found")
  if (target.role === "operator") {
    throw AppError.forbidden(`You cannot ${verb} an operator account from the console.`)
  }
}
