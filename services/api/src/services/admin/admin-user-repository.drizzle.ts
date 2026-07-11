
import type postgres from "postgres"
import type { Queryable, Sql } from "../../db/client.js"
import { writeAudit } from "./audit.js"
import { clampLimit, decodeCursor } from "./pagination.js"
import { paginate } from "../../db/cursor-helpers.js"
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
import { likeContains } from "./like.js"

type SqlFragment = postgres.Fragment

function searchUsersFragment(sql: Queryable, q: string | null): SqlFragment {
  if (q === null) return sql``
  const like = likeContains(q)
  return sql`AND (
    u.display_name ILIKE ${like} ESCAPE '\\'
    OR (u.handle::text) ILIKE ${like} ESCAPE '\\'
    OR EXISTS (
      SELECT 1 FROM reports r2
      JOIN jurisdictions j2 ON j2.geoid = r2.jurisdiction_geoid
      WHERE r2.reporter_user_id = u.id AND j2.name ILIKE ${like} ESCAPE '\\'
    )
  )`
}

interface UserRowSelect {
  id: string
  name: string | null
  handle: string | null
  email_verified: boolean
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
  verified: boolean
  report_verified: boolean
  avatar_url: string | null
  deleted_at: Date | null
}

function toRecord(r: UserRowSelect): AdminUserRecord {
  return {
    id: r.id,
    name: r.name ?? "Neighbor",
    handle: r.handle,
    emailVerified: r.email_verified,
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
    verified: r.verified,
    reportVerified: r.report_verified,
    avatarUrl: r.avatar_url,
    deletedAt: r.deleted_at,
  }
}

function userSelect(
  sql: Queryable,
  extraWhere: SqlFragment,
  orderLimit: SqlFragment,
  withMessages: boolean,
): SqlFragment {
  const messages = withMessages
    ? sql`(
        (SELECT COUNT(*) FROM chat_messages msg WHERE msg.sender_id = u.id)
        + (SELECT COUNT(*) FROM dm_messages dmsg WHERE dmsg.sender_id = u.id)
      )::text`
    : sql`'0'::text`
  return sql`
    SELECT
      u.id,
      u.display_name AS name,
      u.handle,
      u.email_verified,
      (
        SELECT j.name FROM reports r
        LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
        WHERE r.reporter_user_id = u.id AND j.name IS NOT NULL
        ORDER BY r.created_at DESC LIMIT 1
      ) AS city,
      u.role,
      u.avatar_url,
      u.created_at,
      u.deleted_at,
      (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_active_at,
      COALESCE(um.account_status, 'active') AS account_status,
      (SELECT COUNT(*) FROM reports r WHERE r.reporter_user_id = u.id AND r.deleted_at IS NULL)::text AS reports,
      (SELECT COUNT(*) FROM cleanup_members cm WHERE cm.user_id = u.id)::text AS cleanups,
      ${messages} AS messages,
      COALESCE(um.removals, 0) AS removals,
      COALESCE(um.strikes, 0) AS strikes,
      COALESCE(um.risk, 'low') AS risk,
      COALESCE(um.flagged, false) AS flagged,
      um.flag_reason,
      EXISTS (
        SELECT 1 FROM user_verification uv WHERE uv.user_id = u.id AND uv.status = 'verified'
      ) AS verified,
      COALESCE(um.report_verified, false) AS report_verified
    FROM users u
    LEFT JOIN user_moderation um ON um.user_id = u.id
    WHERE TRUE
    ${extraWhere}
    ${orderLimit}
  `
}

export function makeDrizzleAdminUserRepository(sql: Sql): AdminUserRepository {
  return {
    async listUsers(
      args: ListUsersArgs,
    ): Promise<{ records: AdminUserRecord[]; nextCursor: string | null }> {
      const limit = clampLimit(args.limit)
      const anchor = decodeKeyset(args.cursor)

      const conds: SqlFragment[] = []
      if (args.status !== null) {
        conds.push(sql`AND COALESCE(um.account_status, 'active') = ${args.status}`)
      }
      if (args.flaggedOnly) conds.push(sql`AND COALESCE(um.flagged, false) = true`)
      if (args.q !== null) conds.push(searchUsersFragment(sql, args.q))
      if (anchor !== null) {
        conds.push(sql`AND (u.created_at, u.id) < (${anchor.createdAt}, ${anchor.id}::uuid)`)
      }
      const extraWhere = conds.reduce<SqlFragment>((acc, c) => sql`${acc} ${c}`, sql``)
      const orderLimit = sql`ORDER BY u.created_at DESC, u.id DESC LIMIT ${limit + 1}`

      const rows = (await userSelect(sql, extraWhere, orderLimit, false)) as unknown as UserRowSelect[]
      const { items, nextCursor } = paginate(rows, limit, (r) => ({
        ...(r.created_at !== null ? { createdAt: r.created_at } : {}),
        id: r.id,
      }))
      return { records: items.map(toRecord), nextCursor }
    },

    async countByFacet(args: { q: string | null }): Promise<AdminUserCounts> {
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
        WHERE TRUE
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
        true,
      )) as unknown as UserRowSelect[]
      return rows[0] ? toRecord(rows[0]) : null
    },

    async listUserReports(
      id: string,
      cursor: string | null,
      limit: number,
    ): Promise<{ records: UserReportRecord[]; nextCursor: string | null }> {
      const lim = clampLimit(limit)
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
      const { items, nextCursor } = paginate(
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
      return { records: items, nextCursor }
    },

    async listUserEvents(
      id: string,
      cursor: string | null,
      limit: number,
    ): Promise<{ records: UserEventRecord[]; nextCursor: string | null }> {
      const lim = clampLimit(limit)
      const anchor = decodeKeyset(cursor)
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
      const { items, nextCursor } = paginate(
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
      return { records: items, nextCursor }
    },

    async listUserMessages(
      id: string,
      cursor: string | null,
      limit: number,
    ): Promise<{ records: UserMessageRecord[]; nextCursor: string | null }> {
      const lim = clampLimit(limit)
      const anchor = decodeKeyset(cursor)
      const cursorFilter =
        anchor !== null
          ? sql`AND (m.created_at, m.id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
          : sql``
      const rows = await sql<
        {
          id: string
          body: string | null
          thread: string | null
          created_at: Date
          deleted_at: Date | null
          source: "chat" | "dm" | "report"
        }[]
      >`
        SELECT m.id, m.body, m.thread, m.created_at, m.deleted_at, m.source
        FROM (
          SELECT cm.id, cm.body, c.title AS thread, cm.created_at, cm.deleted_at, 'chat' AS source
          FROM chat_messages cm
          LEFT JOIN cleanups c ON c.id = cm.cleanup_id
          WHERE cm.sender_id = ${id} AND cm.report_id IS NULL
          UNION ALL
          SELECT dm.id, dm.body, COALESCE(NULLIF('@' || other.handle::text, '@'), other.display_name) AS thread,
                 dm.created_at, dm.deleted_at, 'dm' AS source
          FROM dm_messages dm
          JOIN dm_threads t ON t.id = dm.thread_id
          LEFT JOIN users other
            ON other.id = CASE WHEN t.user_lo = ${id} THEN t.user_hi ELSE t.user_lo END
          WHERE dm.sender_id = ${id}
          UNION ALL
          SELECT rcm.id, rcm.body, rc.title AS thread, rcm.created_at, rcm.deleted_at, 'report' AS source
          FROM chat_messages rcm
          JOIN reports rc ON rc.id = rcm.report_id
          WHERE rcm.sender_id = ${id} AND rcm.report_id IS NOT NULL
        ) m
        WHERE TRUE
        ${cursorFilter}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${lim + 1}
      `
      const { items, nextCursor } = paginate(
        rows.map((r) => ({
          id: r.id,
          text: r.body ?? "",
          thread: r.thread ?? threadFallback(r.source),
          createdAt: r.created_at,
          deletedAt: r.deleted_at,
          source: r.source,
        })),
        lim,
        (r) => ({ createdAt: r.createdAt, id: r.id }),
      )
      return { records: items, nextCursor }
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

    async setVerified(
      id: string,
      input: { verified: boolean; actorId: string | null },
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const exists = await tx<{ id: string }[]>`
          SELECT id FROM users WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
        `
        if (exists.length === 0) return false
        const prior = await tx<{ status: string }[]>`
          SELECT status FROM user_verification WHERE user_id = ${id} LIMIT 1
        `
        const priorStatus = prior[0]?.status ?? "unverified"
        if (input.verified) {
          await tx`
            INSERT INTO user_verification (user_id, status, reviewed_by, reviewed_at, updated_at)
            VALUES (${id}, 'verified', ${input.actorId}, now(), now())
            ON CONFLICT (user_id) DO UPDATE SET
              status = 'verified',
              reviewed_by = ${input.actorId},
              reviewed_at = now(),
              rejection_reason = NULL,
              updated_at = now()
          `
        } else {
          await tx`DELETE FROM user_verification WHERE user_id = ${id}`
        }
        await writeAudit(tx, {
          actorId: input.actorId,
          action: input.verified ? "user.verified" : "user.unverified",
          target: `user:${id}`,
          meta: { priorStatus },
        })
        return true
      })
    },

    async setReportVerified(
      id: string,
      input: { value: boolean; actorId: string | null },
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const exists = await tx<{ id: string }[]>`
          SELECT id FROM users WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
        `
        if (exists.length === 0) return false
        const stampedAt = input.value ? tx`now()` : tx`NULL`
        const stampedBy = input.value ? input.actorId : null
        await tx`
          INSERT INTO user_moderation (user_id, report_verified, report_verified_at, report_verified_by, updated_at)
          VALUES (${id}, ${input.value}, ${stampedAt}, ${stampedBy}, now())
          ON CONFLICT (user_id) DO UPDATE SET
            report_verified = ${input.value},
            report_verified_at = ${stampedAt},
            report_verified_by = ${stampedBy},
            updated_at = now()
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: input.value ? "user.report_verified" : "user.report_unverified",
          target: `user:${id}`,
          meta: {},
        })
        return true
      })
    },

    async removeUserMessage(
      userId: string,
      messageId: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const chat = await tx<{ id: string }[]>`
          UPDATE chat_messages
          SET deleted_at = now()
          WHERE id = ${messageId} AND sender_id = ${userId} AND deleted_at IS NULL
          RETURNING id
        `
        const dm =
          chat.length > 0
            ? []
            : await tx<{ id: string }[]>`
                UPDATE dm_messages
                SET deleted_at = now()
                WHERE id = ${messageId} AND sender_id = ${userId} AND deleted_at IS NULL
                RETURNING id
              `
        if (chat.length === 0 && dm.length === 0) return false
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "message.removed",
          target: `message:${messageId}`,
          meta: { userId, reason: input.reason },
        })
        return true
      })
    },
  }
}

const decodeKeyset = (cursor: string | null | undefined) => decodeCursor(cursor, true)

function threadFallback(source: "chat" | "dm" | "report"): string {
  switch (source) {
    case "dm":
      return "Direct message"
    case "report":
      return "Report chat"
    default:
      return "Cleanup chat"
  }
}
