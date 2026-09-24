import type { Queryable, Sql, SqlFragment } from "../../db/client.js"
import { insertAuditRow } from "./audit-repository.drizzle.js"
import { assertTargetIsNotOperatorRole } from "../../auth/operator-target.js"
import { clampLimit } from "./pagination.js"
import {
  keysetInstant,
  keysetPredicate,
  paginateKeyset,
  parseKeysetCursor,
} from "../../db/cursor-helpers.js"
import { andAll, ilikeAnyOf } from "./sql-fragments.js"
import type {
  AdminUserOrganizationRecord,
  AdminUserRecord,
  AdminUserRepository,
  ListUsersArgs,
  UserEventRecord,
  UserMessageRecord,
  UserReportRecord,
} from "./admin-user-repository.js"
import type {
  AdminReportStatus,
  AdminUserCounts,
  CleanupMemberRole,
  OrganizationMemberRole,
  ReportCategory,
  Risk,
  Role,
  UserStatus,
} from "@civfix/shared"
import { likeContains } from "../../db/like.js"

const ADMIN_USER_ORGANIZATIONS_LIMIT = 25

const EPOCH = new Date(0)

const CITY_MATCH_USER_CAP = 5000

const UNNAMED_USER_NAME = "Neighbor"
const UNTITLED_REPORT_TITLE = "Untitled report"
const UNTITLED_CLEANUP_TITLE = "Cleanup"

interface FacetCountRow {
  all: string
  active: string
  suspended: string
  flagged: string
  deleted: string
  banned: string
}

function toFacetCounts(row: FacetCountRow | undefined): AdminUserCounts {
  return {
    all: Number(row?.all ?? "0"),
    active: Number(row?.active ?? "0"),
    suspended: Number(row?.suspended ?? "0"),
    flagged: Number(row?.flagged ?? "0"),
    deleted: Number(row?.deleted ?? "0"),
    banned: Number(row?.banned ?? "0"),
  }
}

function searchUsersFragment(
  sql: Queryable,
  q: string | null,
  cityUserIds: readonly string[],
): SqlFragment {
  if (q === null) return sql``
  const extra: SqlFragment[] =
    cityUserIds.length > 0 ? [sql`u.id = ANY(${cityUserIds}::uuid[])`] : []
  return sql`AND ${ilikeAnyOf(sql, [sql`u.display_name`, sql`u.handle::text`], q, extra)}`
}

async function resolveCityMatchUserIds(sql: Queryable, q: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT DISTINCT r2.reporter_user_id AS id
    FROM reports r2
    JOIN jurisdictions j2 ON j2.geoid = r2.jurisdiction_geoid
    WHERE r2.reporter_user_id IS NOT NULL AND j2.name ILIKE ${likeContains(q)} ESCAPE '\\'
    LIMIT ${CITY_MATCH_USER_CAP}
  `
  return rows.map((r) => r.id)
}

interface UserRowSelect {
  id: string
  name: string | null
  handle: string | null
  email_verified: boolean
  city: string | null
  role: Role
  created_at: Date | null
  cursor_at: string | null
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
  report_verified: boolean
  avatar_url: string | null
  deleted_at: Date | null
}

function toRecord(r: UserRowSelect): AdminUserRecord {
  return {
    id: r.id,
    name: r.name ?? UNNAMED_USER_NAME,
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
      ${keysetInstant(sql, sql`u.created_at`)} AS cursor_at,
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
      const anchor = parseKeysetCursor(args.cursor)

      const conds: SqlFragment[] = []
      if (args.status !== null) {
        conds.push(sql`AND COALESCE(um.account_status, 'active') = ${args.status}`)
      }
      if (args.flaggedOnly) conds.push(sql`AND COALESCE(um.flagged, false) = true`)
      if (args.deletedOnly) conds.push(sql`AND u.deleted_at IS NOT NULL`)
      if (args.q !== null) {
        const cityUserIds = await resolveCityMatchUserIds(sql, args.q)
        conds.push(searchUsersFragment(sql, args.q, cityUserIds))
      }
      if (anchor !== null) {
        conds.push(sql`AND ${keysetPredicate(sql, sql`u.created_at`, sql`u.id`, anchor)}`)
      }
      const extraWhere = andAll(sql, conds)
      const orderLimit = sql`ORDER BY u.created_at DESC, u.id DESC LIMIT ${limit + 1}`

      const rows = (await userSelect(
        sql,
        extraWhere,
        orderLimit,
        false,
      )) as unknown as UserRowSelect[]
      const { items, nextCursor } = paginateKeyset(rows, limit, (r) => ({
        atText: r.cursor_at ?? EPOCH.toISOString(),
        id: r.id,
      }))
      return { records: items.map(toRecord), nextCursor }
    },

    async countByFacet(args: { q: string | null }): Promise<AdminUserCounts> {
      if (args.q === null) {
        const rows = await sql<FacetCountRow[]>`
          SELECT
            COUNT(*)::text AS all,
            COUNT(*) FILTER (WHERE COALESCE(um.account_status, 'active') = 'active')::text AS active,
            COUNT(*) FILTER (WHERE COALESCE(um.account_status, 'active') = 'suspended')::text AS suspended,
            COUNT(*) FILTER (WHERE COALESCE(um.flagged, false))::text AS flagged,
            COUNT(*) FILTER (WHERE u.deleted_at IS NOT NULL)::text AS deleted,
            COUNT(*) FILTER (WHERE COALESCE(um.account_status, 'active') = 'banned')::text AS banned
          FROM users u
          LEFT JOIN user_moderation um ON um.user_id = u.id
        `
        return toFacetCounts(rows[0])
      }

      const cityUserIds = await resolveCityMatchUserIds(sql, args.q)
      const search = searchUsersFragment(sql, args.q, cityUserIds)
      const rows = await sql<FacetCountRow[]>`
        SELECT
          COUNT(*)::text AS all,
          COUNT(*) FILTER (WHERE COALESCE(um.account_status, 'active') = 'active')::text AS active,
          COUNT(*) FILTER (WHERE COALESCE(um.account_status, 'active') = 'suspended')::text AS suspended,
          COUNT(*) FILTER (WHERE COALESCE(um.flagged, false))::text AS flagged,
          COUNT(*) FILTER (WHERE u.deleted_at IS NOT NULL)::text AS deleted,
          COUNT(*) FILTER (WHERE COALESCE(um.account_status, 'active') = 'banned')::text AS banned
        FROM users u
        LEFT JOIN user_moderation um ON um.user_id = u.id
        WHERE TRUE
        ${search}
      `
      return toFacetCounts(rows[0])
    },

    async userExists(id: string): Promise<boolean> {
      const rows = await sql<{ ok: number }[]>`SELECT 1 AS ok FROM users WHERE id = ${id} LIMIT 1`
      return rows.length > 0
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
      const anchor = parseKeysetCursor(cursor)
      const cursorFilter =
        anchor !== null
          ? sql`AND ${keysetPredicate(sql, sql`r.created_at`, sql`r.id`, anchor)}`
          : sql``
      const rows = await sql<
        {
          id: string
          category: ReportCategory
          title: string | null
          place: string | null
          status: AdminReportStatus
          created_at: Date
          cursor_at: string
        }[]
      >`
        SELECT r.id, r.category, r.title, j.name AS place, r.status, r.created_at,
               ${keysetInstant(sql, sql`r.created_at`)} AS cursor_at
        FROM reports r
        LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
        WHERE r.reporter_user_id = ${id} AND r.deleted_at IS NULL
        ${cursorFilter}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${lim + 1}
      `
      const { items, nextCursor } = paginateKeyset(rows, lim, (r) => ({
        atText: r.cursor_at,
        id: r.id,
      }))
      return {
        records: items.map((r) => ({
          id: r.id,
          category: r.category,
          title: r.title ?? UNTITLED_REPORT_TITLE,
          place: r.place ?? "",
          status: r.status,
          createdAt: r.created_at,
        })),
        nextCursor,
      }
    },

    async listUserEvents(
      id: string,
      cursor: string | null,
      limit: number,
    ): Promise<{ records: UserEventRecord[]; nextCursor: string | null }> {
      const lim = clampLimit(limit)
      const anchor = parseKeysetCursor(cursor)
      const cursorFilter =
        anchor !== null
          ? sql`AND ${keysetPredicate(sql, sql`cm.joined_at`, sql`c.id`, anchor)}`
          : sql``
      const rows = await sql<
        {
          id: string
          title: string | null
          place: string | null
          role: CleanupMemberRole
          attendees: string
          when_at: Date
          cursor_at: string
        }[]
      >`
        SELECT
          c.id,
          c.title,
          c.address AS place,
          cm.role,
          (SELECT COUNT(*) FROM cleanup_members x WHERE x.cleanup_id = c.id)::text AS attendees,
          cm.joined_at AS when_at,
          ${keysetInstant(sql, sql`cm.joined_at`)} AS cursor_at
        FROM cleanup_members cm
        JOIN cleanups c ON c.id = cm.cleanup_id
        WHERE cm.user_id = ${id}
        ${cursorFilter}
        ORDER BY cm.joined_at DESC, c.id DESC
        LIMIT ${lim + 1}
      `
      const { items, nextCursor } = paginateKeyset(rows, lim, (r) => ({
        atText: r.cursor_at,
        id: r.id,
      }))
      return {
        records: items.map((r) => ({
          id: r.id,
          title: r.title ?? UNTITLED_CLEANUP_TITLE,
          place: r.place ?? "",
          role: r.role,
          attendees: Number(r.attendees ?? "0"),
          whenAt: r.when_at,
        })),
        nextCursor,
      }
    },

    async listUserMessages(
      id: string,
      cursor: string | null,
      limit: number,
    ): Promise<{ records: UserMessageRecord[]; nextCursor: string | null }> {
      const lim = clampLimit(limit)
      const anchor = parseKeysetCursor(cursor)
      const branchCursor = (createdAt: SqlFragment, id2: SqlFragment): SqlFragment =>
        anchor !== null ? sql`AND ${keysetPredicate(sql, createdAt, id2, anchor)}` : sql``
      const probe = lim + 1
      const rows = await sql<
        {
          id: string
          body: string | null
          thread: string | null
          created_at: Date
          cursor_at: string
          deleted_at: Date | null
          source: "chat" | "group" | "dm" | "report"
          source_id: string | null
        }[]
      >`
        SELECT m.id, m.body, m.thread, m.created_at, ${keysetInstant(sql, sql`m.created_at`)} AS cursor_at,
               m.deleted_at, m.source, m.source_id
        FROM (
          -- Event chat: the navigable origin is the cleanup/event the message belongs to.
          (SELECT cm.id, cm.body, c.title AS thread, cm.created_at, cm.deleted_at, 'chat' AS source,
                 cm.cleanup_id AS source_id
          FROM chat_messages cm
          JOIN cleanups c ON c.id = cm.cleanup_id
          WHERE cm.sender_id = ${id} AND cm.cleanup_id IS NOT NULL
          ${branchCursor(sql`cm.created_at`, sql`cm.id`)}
          ORDER BY cm.created_at DESC, cm.id DESC
          LIMIT ${probe})
          UNION ALL
          -- Standalone group chats are distinct from cleanup chat and have no admin detail destination.
          (SELECT gcm.id, gcm.body, cg.name AS thread, gcm.created_at, gcm.deleted_at, 'group' AS source,
                 gcm.group_id AS source_id
          FROM chat_messages gcm
          JOIN chat_groups cg ON cg.id = gcm.group_id
          WHERE gcm.sender_id = ${id} AND gcm.group_id IS NOT NULL
          ${branchCursor(sql`gcm.created_at`, sql`gcm.id`)}
          ORDER BY gcm.created_at DESC, gcm.id DESC
          LIMIT ${probe})
          UNION ALL
          -- DM: no admin surface to navigate to -> source_id NULL.
          (SELECT dm.id, dm.body, COALESCE(NULLIF('@' || other.handle::text, '@'), other.display_name) AS thread,
                 dm.created_at, dm.deleted_at, 'dm' AS source, NULL::uuid AS source_id
          FROM dm_messages dm
          JOIN dm_threads t ON t.id = dm.thread_id
          LEFT JOIN users other
            ON other.id = CASE WHEN t.user_lo = ${id} THEN t.user_hi ELSE t.user_lo END
          WHERE dm.sender_id = ${id}
          ${branchCursor(sql`dm.created_at`, sql`dm.id`)}
          ORDER BY dm.created_at DESC, dm.id DESC
          LIMIT ${probe})
          UNION ALL
          -- Report discussion: the navigable origin is the parent report.
          (SELECT rcm.id, rcm.body, rc.title AS thread, rcm.created_at, rcm.deleted_at, 'report' AS source,
                 rcm.report_id AS source_id
          FROM chat_messages rcm
          JOIN reports rc ON rc.id = rcm.report_id
          WHERE rcm.sender_id = ${id} AND rcm.report_id IS NOT NULL
          ${branchCursor(sql`rcm.created_at`, sql`rcm.id`)}
          ORDER BY rcm.created_at DESC, rcm.id DESC
          LIMIT ${probe})
        ) m
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${probe}
      `
      const { items, nextCursor } = paginateKeyset(rows, lim, (r) => ({
        atText: r.cursor_at,
        id: r.id,
      }))
      return {
        records: items.map((r) => ({
          id: r.id,
          text: r.body ?? "",
          thread: r.thread ?? threadFallback(r.source),
          createdAt: r.created_at,
          deletedAt: r.deleted_at,
          source: r.source,
          sourceId: r.source_id,
        })),
        nextCursor,
      }
    },

    async toggleFlag(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<boolean | null> {
      return sql.begin(async (tx) => {
        const exists = await tx<{ id: string }[]>`
          SELECT id FROM users WHERE id = ${id} AND deleted_at IS NULL FOR NO KEY UPDATE
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
        await insertAuditRow(tx, {
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
        // The service's operator check ran in an earlier query; re-check on the locked row so a target
        // promoted in between cannot be banned or suspended from the console.
        const target = await tx<{ id: string; role: Role }[]>`
          SELECT id, role FROM users WHERE id = ${id} AND deleted_at IS NULL FOR NO KEY UPDATE
        `
        const row = target[0]
        if (row === undefined) return false
        assertTargetIsNotOperatorRole(row.role, "ban or change the status of")
        await tx`
          INSERT INTO user_moderation (user_id, account_status, updated_at)
          VALUES (${id}, ${input.status}, now())
          ON CONFLICT (user_id)
          DO UPDATE SET account_status = EXCLUDED.account_status, updated_at = now()
        `
        await insertAuditRow(tx, {
          actorId: input.actorId,
          action: input.status === "banned" ? "user.banned" : "user.status_changed",
          target: `user:${id}`,
          meta: { status: input.status, reason: input.reason },
        })
        return true
      })
    },

    async applyRole(id: string, input: { role: Role; actorId: string | null }): Promise<boolean> {
      return sql.begin(async (tx) => {
        const existing = await tx<{ role: Role }[]>`
          SELECT role FROM users WHERE id = ${id} AND deleted_at IS NULL FOR NO KEY UPDATE
        `
        const priorRole = existing[0]?.role
        if (priorRole === undefined) return false
        assertTargetIsNotOperatorRole(priorRole, "change the role of")
        await tx`UPDATE users SET role = ${input.role} WHERE id = ${id}`
        await insertAuditRow(tx, {
          actorId: input.actorId,
          action: "user.role_changed",
          target: `user:${id}`,
          meta: { role: input.role, priorRole },
        })
        return true
      })
    },

    async listUserOrganizations(id: string): Promise<AdminUserOrganizationRecord[]> {
      const rows = await sql<
        { id: string; slug: string; name: string; role: OrganizationMemberRole }[]
      >`
        SELECT o.id, o.slug, o.name, m.role
        FROM organization_members m
        JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = ${id} AND o.deleted_at IS NULL
        ORDER BY m.joined_at ASC, o.id ASC
        LIMIT ${ADMIN_USER_ORGANIZATIONS_LIMIT}
      `
      return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, role: r.role }))
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
        await insertAuditRow(tx, {
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
        await insertAuditRow(tx, {
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

function threadFallback(source: "chat" | "group" | "dm" | "report"): string {
  switch (source) {
    case "group":
      return "Group chat"
    case "dm":
      return "Direct message"
    case "report":
      return "Report chat"
    default:
      return "Cleanup chat"
  }
}
