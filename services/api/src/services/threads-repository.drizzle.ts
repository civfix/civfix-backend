import { REPORT_CATEGORY_LABELS } from "@civfix/shared"
import type { ReportCategory } from "@civfix/shared"
import type { Sql, SqlFragment } from "../db/client.js"
import type { ConversationHideRoomKind } from "../db/schema/conversation_hides.js"
import { publicReportFilter } from "./report-sql.js"
import type { TimeCursor } from "../db/cursor-helpers.js"
import {
  THREADS_DEFAULT_LIMIT,
  type GroupThreadAggregateView,
  type GroupThreadsSource,
  type ReportThreadAggregateView,
  type ReportThreadsSource,
  type ThreadAggregate,
  type ThreadsRepository,
} from "./threads-service.js"

function threadsCursorFilter(
  sql: Sql,
  activity: SqlFragment,
  idColumn: SqlFragment,
  cursor: TimeCursor | null | undefined,
): SqlFragment {
  if (cursor === null || cursor === undefined) return sql``
  const msCeiling = new Date(cursor.at.getTime() + 1)
  return sql`
    AND ${activity} < ${msCeiling}
    AND (${activity} < ${cursor.at} OR ${idColumn} < ${cursor.id}::uuid)
  `
}

function reportThreadTitle(category: ReportCategory | string, addr: string | null): string {
  const label = REPORT_CATEGORY_LABELS[category as ReportCategory] ?? category
  const short = (addr ?? "").split(",")[0]?.trim() ?? ""
  return short !== "" ? `${label} - ${short}` : label
}

interface ThreadFamilyRow {
  room_id: string
  joined_at: Date
  members: number
  unread: number
  last_body: string | null
  last_created_at: Date | null
  last_sender_id: string | null
}

interface ThreadFamilySpec {
  memberTable: string
  roomTable: string
  scopeColumn: string
  roomKind: ConversationHideRoomKind
  columns: SqlFragment
  where?: SqlFragment
}

async function listThreadFamily<R extends ThreadFamilyRow>(
  sql: Sql,
  spec: ThreadFamilySpec,
  userId: string,
  limit: number,
  cursor: TimeCursor | null | undefined,
): Promise<R[]> {
  const scope = sql(spec.scopeColumn)
  const rawActivity = sql`COALESCE(last_msg.created_at, mem.joined_at)`
  const activity = sql`date_trunc('milliseconds', ${rawActivity})`
  const cursorFilter = threadsCursorFilter(sql, activity, sql`r.id`, cursor)
  return await sql<R[]>`
    WITH page AS (
      SELECT
        r.id AS room_id,
        mem.joined_at AS joined_at,
        mem.last_read_at AS last_read_at,
        ${activity} AS activity
      FROM ${sql(spec.memberTable)} mem
      JOIN ${sql(spec.roomTable)} r ON r.id = mem.${scope}
      LEFT JOIN LATERAL (
        SELECT cm.created_at
        FROM chat_messages cm
        WHERE cm.${scope} = r.id AND cm.deleted_at IS NULL
        ORDER BY cm.created_at DESC, cm.id DESC
        LIMIT 1
      ) last_msg ON TRUE
      LEFT JOIN conversation_hides h
        ON h.user_id = ${userId} AND h.room_kind = ${spec.roomKind} AND h.room_id = r.id
      WHERE mem.user_id = ${userId}
        AND (h.hidden_at IS NULL OR ${rawActivity} > h.hidden_at)
        ${spec.where ?? sql``}
        ${cursorFilter}
      ORDER BY ${activity} DESC, r.id DESC
      LIMIT ${limit}
    )
    SELECT
      page.room_id,
      ${spec.columns},
      page.joined_at,
      (SELECT count(*)::int FROM ${sql(spec.memberTable)} m WHERE m.${scope} = page.room_id) AS members,
      (
        SELECT count(*)::int
        FROM chat_messages cm
        WHERE cm.${scope} = page.room_id
          AND cm.deleted_at IS NULL
          AND cm.sender_id IS DISTINCT FROM ${userId}
          AND cm.created_at > GREATEST(page.joined_at, COALESCE(page.last_read_at, to_timestamp(0)))
      ) AS unread,
      last_msg.body AS last_body,
      last_msg.created_at AS last_created_at,
      last_msg.sender_id AS last_sender_id
    FROM page
    JOIN ${sql(spec.roomTable)} r ON r.id = page.room_id
    LEFT JOIN LATERAL (
      SELECT cm.body, cm.created_at, cm.sender_id
      FROM chat_messages cm
      WHERE cm.${scope} = page.room_id AND cm.deleted_at IS NULL
      ORDER BY cm.created_at DESC, cm.id DESC
      LIMIT 1
    ) last_msg ON TRUE
    ORDER BY page.activity DESC, page.room_id DESC
  `
}

function lastOf(
  r: ThreadFamilyRow,
): { body: string | null; createdAt: Date; senderId: string | null } | null {
  return r.last_created_at !== null
    ? { body: r.last_body, createdAt: r.last_created_at, senderId: r.last_sender_id }
    : null
}

const CLEANUP_FAMILY = (sql: Sql): ThreadFamilySpec => ({
  memberTable: "cleanup_members",
  roomTable: "cleanups",
  scopeColumn: "cleanup_id",
  roomKind: "cleanup",
  columns: sql`r.title`,
})

const REPORT_FAMILY = (sql: Sql, userId: string): ThreadFamilySpec => ({
  memberTable: "report_chat_members",
  roomTable: "reports",
  scopeColumn: "report_id",
  roomKind: "report",
  columns: sql`r.category, r.addr`,
  where: sql`
    AND r.deleted_at IS NULL
    AND ((${publicReportFilter(sql)}) OR r.reporter_user_id = ${userId})
  `,
})

const GROUP_FAMILY = (sql: Sql): ThreadFamilySpec => ({
  memberTable: "chat_group_members",
  roomTable: "chat_groups",
  scopeColumn: "group_id",
  roomKind: "group",
  columns: sql`r.name, r.kind`,
})

export function makeDrizzleThreadsRepository(sql: Sql): ThreadsRepository {
  return {
    async listThreadsFor(
      userId: string,
      limit: number,
      cursor?: TimeCursor | null,
    ): Promise<ThreadAggregate[]> {
      const rows = await listThreadFamily<ThreadFamilyRow & { title: string }>(
        sql,
        CLEANUP_FAMILY(sql),
        userId,
        limit,
        cursor,
      )
      return rows.map((r) => ({
        cleanupId: r.room_id,
        title: r.title,
        joinedAt: r.joined_at,
        members: r.members,
        unread: r.unread,
        last:
          r.last_created_at !== null
            ? { body: r.last_body, createdAt: r.last_created_at, senderId: r.last_sender_id! }
            : null,
      }))
    },

    async countUnread(cleanupId: string, userId: string, after: Date): Promise<number> {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM chat_messages cm
        WHERE cm.cleanup_id = ${cleanupId}
          AND cm.deleted_at IS NULL
          AND cm.sender_id IS DISTINCT FROM ${userId}
          AND cm.created_at > ${after}
      `
      return rows[0]?.count ?? 0
    },
  }
}

export function makeDrizzleReportThreadsSource(sql: Sql): ReportThreadsSource {
  return {
    async listReportThreadsFor(
      userId: string,
      limit = THREADS_DEFAULT_LIMIT,
      cursor?: TimeCursor | null,
    ): Promise<ReportThreadAggregateView[]> {
      const rows = await listThreadFamily<
        ThreadFamilyRow & { category: string; addr: string | null }
      >(sql, REPORT_FAMILY(sql, userId), userId, limit, cursor)
      return rows.map((r) => ({
        reportId: r.room_id,
        title: reportThreadTitle(r.category, r.addr),
        members: r.members,
        unread: r.unread,
        joinedAt: r.joined_at,
        last: lastOf(r),
      }))
    },
  }
}

export function makeDrizzleGroupThreadsSource(sql: Sql): GroupThreadsSource {
  return {
    async listGroupThreadsFor(
      userId: string,
      limit = THREADS_DEFAULT_LIMIT,
      cursor?: TimeCursor | null,
    ): Promise<GroupThreadAggregateView[]> {
      const rows = await listThreadFamily<
        ThreadFamilyRow & { name: string; kind: "group" | "channel" }
      >(sql, GROUP_FAMILY(sql), userId, limit, cursor)
      return rows.map((r) => ({
        groupId: r.room_id,
        title: r.name,
        kind: r.kind,
        members: r.members,
        unread: r.unread,
        joinedAt: r.joined_at,
        last: lastOf(r),
      }))
    },
  }
}
