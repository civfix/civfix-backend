/**
 * Postgres-backed AdminUserRepository (Phase 2): the production binding of the admin users seam.
 *
 * Written against the raw postgres-js tag (`Sql`) like the other admin repos. Reads join users +
 * user_moderation (LEFT, so a user with no moderation row defaults to active/low/0) and compute the
 * derived counts (reports, cleanup_members), the "city" (best-effort from the jurisdiction of the user's
 * most recent report; users have no city column), and lastActive (max sessions.last_seen_at). The three
 * sub-activity lists page the user's own reports / cleanup memberships / chat messages with a
 * (created_at, id) keyset. Mutations upsert user_moderation in a transaction + audit in-tx.
 *
 * FLAG: user_moderation.flagged + flag_reason AND an abuse_flag (subject_type 'user', which the frozen
 * enum supports). STATUS: user_moderation.account_status. ROLE: written by the route via the injected
 * SetUserRole (UserStore.setRole); this repo only records the role-change audit.
 */

import type postgres from "postgres"
import type { Queryable, Sql } from "../../db/client.js"
import { writeAudit } from "./audit.js"
import { clampLimit, decodeCursor, encodeCursor, type CursorAnchor } from "./pagination.js"
import type {
  AdminUserRecord,
  AdminUserRepository,
  ListUsersArgs,
  UserEventRecord,
  UserMessageRecord,
  UserReportRecord,
} from "./admin-user-service.js"
import type {
  AdminReportStatus,
  AdminUserCounts,
  ReportCategory,
  Risk,
  Role,
  UserStatus,
} from "@civfix/shared"

/** A composable SQL fragment (postgres.js Fragment). */
type SqlFragment = postgres.Fragment

/**
 * The user-search predicate (display name / handle / CITY via the reports->jurisdictions join), shared by
 * listUsers + countByFacet so the chip counts match the list exactly. Assumes the query selects `users u`.
 * Empty fragment when q is null.
 */
function searchUsersFragment(sql: Queryable, q: string | null): SqlFragment {
  if (q === null) return sql``
  const like = `%${q}%`
  return sql`AND (
    u.display_name ILIKE ${like}
    OR (u.handle::text) ILIKE ${like}
    OR EXISTS (
      SELECT 1 FROM reports r2
      JOIN jurisdictions j2 ON j2.geoid = r2.jurisdiction_geoid
      WHERE r2.reporter_user_id = u.id AND j2.name ILIKE ${like}
    )
  )`
}

/** A users list/detail row as selected back (moderation joined, counts + city + lastActive computed). */
interface UserRowSelect {
  id: string
  name: string | null
  handle: string | null
  email_verified: boolean
  has_oauth: boolean
  city: string | null
  role: Role
  created_at: Date | null
  last_active_at: Date | null
  account_status: UserStatus
  reports: string
  cleanups: string
  messages: string
  removals: number
  strikes: number
  risk: Risk
  flagged: boolean
  flag_reason: string | null
}

/** Project a selected user row into the structural record the service consumes. */
function toRecord(r: UserRowSelect): AdminUserRecord {
  return {
    id: r.id,
    name: r.name ?? "Neighbor",
    handle: r.handle,
    emailVerified: r.email_verified,
    hasOauth: r.has_oauth,
    city: r.city ?? "",
    role: r.role,
    joinedAt: r.created_at,
    lastActiveAt: r.last_active_at,
    accountStatus: r.account_status,
    reports: Number(r.reports ?? "0"),
    cleanups: Number(r.cleanups ?? "0"),
    messages: Number(r.messages ?? "0"),
    removals: r.removals,
    strikes: r.strikes,
    risk: r.risk,
    flagged: r.flagged,
    flagReason: r.flag_reason,
  }
}

/**
 * The shared user SELECT (moderation LEFT-joined with active/low/0 defaults, counts + city + lastActive
 * computed). The `extraWhere`/`orderLimit` clauses narrow it. Only non-deleted users are listed.
 */
function userSelect(sql: Queryable, extraWhere: SqlFragment, orderLimit: SqlFragment): SqlFragment {
  return sql`
    SELECT
      u.id,
      u.display_name AS name,
      u.handle,
      u.email_verified,
      EXISTS (SELECT 1 FROM oauth_identities oi WHERE oi.user_id = u.id) AS has_oauth,
      (
        SELECT j.name FROM reports r
        LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
        WHERE r.reporter_user_id = u.id AND j.name IS NOT NULL
        ORDER BY r.created_at DESC LIMIT 1
      ) AS city,
      u.role,
      u.created_at,
      (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_active_at,
      COALESCE(um.account_status, 'active') AS account_status,
      (SELECT COUNT(*) FROM reports r WHERE r.reporter_user_id = u.id AND r.deleted_at IS NULL)::text AS reports,
      (SELECT COUNT(*) FROM cleanup_members cm WHERE cm.user_id = u.id)::text AS cleanups,
      (SELECT COUNT(*) FROM chat_messages msg WHERE msg.sender_id = u.id AND msg.deleted_at IS NULL)::text AS messages,
      COALESCE(um.removals, 0) AS removals,
      COALESCE(um.strikes, 0) AS strikes,
      COALESCE(um.risk, 'low') AS risk,
      COALESCE(um.flagged, false) AS flagged,
      um.flag_reason
    FROM users u
    LEFT JOIN user_moderation um ON um.user_id = u.id
    WHERE u.deleted_at IS NULL
    ${extraWhere}
    ${orderLimit}
  `
}

export function makeDrizzleAdminUserRepository(sql: Sql): AdminUserRepository {
  return {
    async listUsers(
      args: ListUsersArgs,
    ): Promise<{ records: AdminUserRecord[]; nextCursor: string | null }> {
      const limit = clampKeyset(args.limit)
      const anchor = decodeKeyset(args.cursor)

      const conds: SqlFragment[] = []
      if (args.status !== null) {
        conds.push(sql`AND COALESCE(um.account_status, 'active') = ${args.status}`)
      }
      if (args.flaggedOnly) conds.push(sql`AND COALESCE(um.flagged, false) = true`)
      // Search by display name / handle (CITEXT cast to hit the users_handle_trgm index) / CITY (the
      // jurisdiction name of the user's reports). Shared with countByFacet via searchUsersFragment so the
      // chips and the list always agree.
      if (args.q !== null) conds.push(searchUsersFragment(sql, args.q))
      if (anchor !== null) {
        conds.push(sql`AND (u.created_at, u.id) < (${anchor.createdAt}, ${anchor.id}::uuid)`)
      }
      const extraWhere = conds.reduce<SqlFragment>((acc, c) => sql`${acc} ${c}`, sql``)
      const orderLimit = sql`ORDER BY u.created_at DESC, u.id DESC LIMIT ${limit + 1}`

      const rows = (await userSelect(sql, extraWhere, orderLimit)) as unknown as UserRowSelect[]
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const records = page.map(toRecord)
      const last = page[page.length - 1]
      const nextCursor =
        hasMore && last && last.created_at
          ? encodeKeyset({ createdAt: last.created_at, id: last.id })
          : null
      return { records, nextCursor }
    },

    async countByFacet(args: { q: string | null }): Promise<AdminUserCounts> {
      // One aggregate over the searched, non-deleted users: total + per-facet (active / suspended) + the
      // orthogonal flagged count. `suspended` is the explicit suspended status (matching the facet).
      const search = searchUsersFragment(sql, args.q)
      const rows = await sql<
        { all: string; active: string; suspended: string; flagged: string }[]
      >`
        SELECT
          COUNT(*)::text AS all,
          COUNT(*) FILTER (WHERE COALESCE(um.account_status, 'active') = 'active')::text AS active,
          COUNT(*) FILTER (WHERE COALESCE(um.account_status, 'active') = 'suspended')::text AS suspended,
          COUNT(*) FILTER (WHERE COALESCE(um.flagged, false) = true)::text AS flagged
        FROM users u
        LEFT JOIN user_moderation um ON um.user_id = u.id
        WHERE u.deleted_at IS NULL
        ${search}
      `
      const r = rows[0]
      return {
        all: Number(r?.all ?? "0"),
        active: Number(r?.active ?? "0"),
        suspended: Number(r?.suspended ?? "0"),
        flagged: Number(r?.flagged ?? "0"),
      }
    },

    async getUser(id: string): Promise<AdminUserRecord | null> {
      const rows = (await userSelect(
        sql,
        sql`AND u.id = ${id}`,
        sql`LIMIT 1`,
      )) as unknown as UserRowSelect[]
      return rows[0] ? toRecord(rows[0]) : null
    },

    async listUserReports(
      id: string,
      cursor: string | null,
      limit: number,
    ): Promise<{ records: UserReportRecord[]; nextCursor: string | null }> {
      const lim = clampKeyset(limit)
      const anchor = decodeKeyset(cursor)
      const cursorFilter =
        anchor !== null
          ? sql`AND (r.created_at, r.id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
          : sql``
      const rows = await sql<
        {
          id: string
          category: ReportCategory
          title: string | null
          place: string | null
          status: AdminReportStatus
          created_at: Date
        }[]
      >`
        SELECT r.id, r.category, r.title, j.name AS place, r.status, r.created_at
        FROM reports r
        LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
        WHERE r.reporter_user_id = ${id} AND r.deleted_at IS NULL
        ${cursorFilter}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${lim + 1}
      `
      return pageRows(
        rows.map((r) => ({
          id: r.id,
          category: r.category,
          title: r.title ?? "Untitled report",
          place: r.place ?? "",
          status: r.status,
          createdAt: r.created_at,
        })),
        lim,
        (r) => ({ createdAt: r.createdAt, id: r.id }),
      )
    },

    async listUserEvents(
      id: string,
      cursor: string | null,
      limit: number,
    ): Promise<{ records: UserEventRecord[]; nextCursor: string | null }> {
      const lim = clampKeyset(limit)
      const anchor = decodeKeyset(cursor)
      // Keyset over the membership's joined_at + cleanup id (a user joins a cleanup at most once).
      const cursorFilter =
        anchor !== null
          ? sql`AND (cm.joined_at, c.id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
          : sql``
      const rows = await sql<
        {
          id: string
          title: string | null
          place: string | null
          role: "organizer" | "member"
          attendees: string
          when_at: Date
        }[]
      >`
        SELECT
          c.id,
          c.title,
          c.address AS place,
          cm.role,
          (SELECT COUNT(*) FROM cleanup_members x WHERE x.cleanup_id = c.id)::text AS attendees,
          cm.joined_at AS when_at
        FROM cleanup_members cm
        JOIN cleanups c ON c.id = cm.cleanup_id
        WHERE cm.user_id = ${id}
        ${cursorFilter}
        ORDER BY cm.joined_at DESC, c.id DESC
        LIMIT ${lim + 1}
      `
      return pageRows(
        rows.map((r) => ({
          id: r.id,
          title: r.title ?? "Cleanup",
          place: r.place ?? "",
          role: r.role,
          attendees: Number(r.attendees ?? "0"),
          whenAt: r.when_at,
        })),
        lim,
        (r) => ({ createdAt: r.whenAt, id: r.id }),
      )
    },

    async listUserMessages(
      id: string,
      cursor: string | null,
      limit: number,
    ): Promise<{ records: UserMessageRecord[]; nextCursor: string | null }> {
      const lim = clampKeyset(limit)
      const anchor = decodeKeyset(cursor)
      const cursorFilter =
        anchor !== null
          ? sql`AND (m.created_at, m.id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
          : sql``
      const rows = await sql<
        { id: string; body: string | null; thread: string | null; created_at: Date }[]
      >`
        SELECT m.id, m.body, c.title AS thread, m.created_at
        FROM chat_messages m
        LEFT JOIN cleanups c ON c.id = m.cleanup_id
        WHERE m.sender_id = ${id} AND m.deleted_at IS NULL
        ${cursorFilter}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${lim + 1}
      `
      return pageRows(
        rows.map((r) => ({
          id: r.id,
          text: r.body ?? "",
          thread: r.thread ?? "Cleanup chat",
          createdAt: r.created_at,
        })),
        lim,
        (r) => ({ createdAt: r.createdAt, id: r.id }),
      )
    },

    async toggleFlag(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<boolean | null> {
      return sql.begin(async (tx) => {
        const exists = await tx<{ id: string }[]>`
          SELECT id FROM users WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
        `
        if (exists.length === 0) return null

        const current = await tx<{ flagged: boolean }[]>`
          SELECT flagged FROM user_moderation WHERE user_id = ${id} LIMIT 1
        `
        const nowFlagged = !(current[0]?.flagged ?? false)
        const reason = nowFlagged ? input.reason : null
        await tx`
          INSERT INTO user_moderation (user_id, flagged, flag_reason, updated_at)
          VALUES (${id}, ${nowFlagged}, ${reason}, now())
          ON CONFLICT (user_id)
          DO UPDATE SET flagged = EXCLUDED.flagged, flag_reason = EXCLUDED.flag_reason, updated_at = now()
        `
        if (nowFlagged) {
          await tx`
            INSERT INTO abuse_flags (subject_type, subject_id, reason, source)
            VALUES ('user', ${id}, 'manual', 'api')
          `
        } else {
          await tx`
            UPDATE abuse_flags SET resolved_at = now()
            WHERE subject_type = 'user' AND subject_id = ${id} AND resolved_at IS NULL
          `
        }
        await writeAudit(tx, {
          actorId: input.actorId,
          action: nowFlagged ? "user.flagged" : "user.unflagged",
          target: `user:${id}`,
          meta: { reason: input.reason },
        })
        return nowFlagged
      })
    },

    async setStatus(
      id: string,
      input: { status: UserStatus; reason: string | null; actorId: string | null },
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const exists = await tx<{ id: string }[]>`
          SELECT id FROM users WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
        `
        if (exists.length === 0) return false
        await tx`
          INSERT INTO user_moderation (user_id, account_status, updated_at)
          VALUES (${id}, ${input.status}, now())
          ON CONFLICT (user_id)
          DO UPDATE SET account_status = EXCLUDED.account_status, updated_at = now()
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: input.status === "banned" ? "user.banned" : "user.status_changed",
          target: `user:${id}`,
          meta: { status: input.status, reason: input.reason },
        })
        return true
      })
    },

    async recordRoleAudit(
      id: string,
      input: { role: Role; actorId: string | null },
    ): Promise<void> {
      await writeAudit(sql, {
        actorId: input.actorId,
        action: "user.role_changed",
        target: `user:${id}`,
        meta: { role: input.role },
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Keyset helpers ((created_at, id) row-value cursor over the shared "<iso>|<id>" format)
// ---------------------------------------------------------------------------

const clampKeyset = clampLimit
const decodeKeyset = decodeCursor
const encodeKeyset = encodeCursor

/** Split a `limit + 1` row set into { records, nextCursor }, deriving the keyset anchor via `pick`. */
function pageRows<T>(
  rows: T[],
  limit: number,
  pick: (row: T) => CursorAnchor,
): { records: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  const nextCursor = hasMore && last ? encodeKeyset(pick(last)) : null
  return { records: page, nextCursor }
}
