/**
 * Postgres-backed ThreadsRepository (the persistence half of the threads seam).
 *
 * listThreadsFor returns the viewer's cleanups (via cleanup_members) joined with the member count, a
 * lateral "most recent message" lookup, AND the viewer's unread count — all in one query, ordered by
 * most recent activity (last message, else joined_at). Folding unread into this single query (a
 * correlated count(*) over chat_messages, served by chat_messages_cleanup_created_idx) avoids the former
 * N+1 fan-out where the service issued a separate countUnread round-trip per thread on every inbox load;
 * it mirrors how the DM repository's listThreadsForUser computes unread in one pass. The watermark is
 * max(joined_at, last_read_at) straight off the membership row (cleanup_members.last_read_at, written by
 * the WS `ack` handler) — the same durable source the per-thread path read via ChatReadState.
 * countUnread is retained on the seam for the in-memory test path / any ad-hoc single-thread count. Both
 * run against the raw postgres-js tag (the message read pages the partitioned chat_messages table).
 */

import { REPORT_CATEGORY_LABELS } from "@civfix/shared"
import type { ReportCategory } from "@civfix/shared"
import type postgres from "postgres"
import type { Sql } from "../db/client.js"
import type { TimeCursor } from "../db/cursor-helpers.js"
import type {
  GroupThreadAggregateView,
  GroupThreadsSource,
  ReportThreadAggregateView,
  ReportThreadsSource,
  ThreadAggregate,
  ThreadsRepository,
} from "./threads-service.js"

type SqlFragment = postgres.Fragment

/**
 * The inbox keyset predicate (THREADS_CURSOR in threads-service.ts), pushed into a family's query: keep
 * rows strictly older than the cursor in the merge's (activity, id) DESC order. `activity` is the family's
 * COALESCE(last message, baseline) expression and `idColumn` its thread id.
 *
 * The `activity` bound is deliberately LOOSE — "the cursor's millisecond, or older" (at + 1ms, exclusive)
 * — because the cursor's ISO timestamp carries milliseconds while created_at is microsecond-resolution. A
 * strict `< at` would drop a row whose microseconds put it inside the cursor's own millisecond, and the
 * service (which merges in millisecond resolution) would never see it again. Over-fetching a row that the
 * service's exact filter then discards is the safe direction.
 */
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

/**
 * Report-thread display title: category label + short address. The label reuses the shared
 * REPORT_CATEGORY_LABELS map (single source, same text the admin console renders); an unmapped
 * category falls back to its raw key. The address is shortened to its first comma segment (the street
 * line) so the row title stays compact; when there is no address the label stands alone.
 */
function reportThreadTitle(category: ReportCategory | string, addr: string | null): string {
  const label = REPORT_CATEGORY_LABELS[category as ReportCategory] ?? category
  const short = (addr ?? "").split(",")[0]?.trim() ?? ""
  return short !== "" ? `${label} - ${short}` : label
}

/**
 * The columns EVERY thread family selects: the room id (uniform `room_id`, whatever the family's own key
 * is called), the viewer's join baseline, the member count, the unread count, and the flattened
 * latest-message triple. Per-family display columns ride alongside via ThreadFamilySpec.columns.
 */
interface ThreadFamilyRow {
  room_id: string
  joined_at: Date
  members: number
  unread: number
  last_body: string | null
  last_created_at: Date | null
  last_sender_id: string | null
}

/**
 * What distinguishes one thread family from the others. Table and column names are module constants
 * below (NEVER user input), interpolated as postgres.js identifiers — the same pattern
 * chat-read-state.drizzle.ts's watermark helpers use.
 */
interface ThreadFamilySpec {
  /** Membership table carrying (user_id, <scopeColumn>, joined_at, last_read_at). */
  memberTable: string
  /** The room table joined for the display columns; aliased `r` in the query. */
  roomTable: string
  /** chat_messages' scope column for this family — also the membership table's room FK. */
  scopeColumn: string
  /** The family's display columns off alias `r` (e.g. `r.title`). */
  columns: SqlFragment
  /** Extra WHERE terms, e.g. the report family's soft-delete exclusion. */
  where?: SqlFragment
}

/**
 * ONE keyset page of a thread family: membership -> room, plus the member count, the unread count and a
 * LATERAL latest-message lookup, newest-activity first. The four families (cleanup / report / group here,
 * dm in dm-repository) were four near-identical copies of this query; the differences are exactly
 * ThreadFamilySpec.
 *
 * Invariants held for every family:
 *   - activity = COALESCE(last message created_at, the viewer's joined_at) drives BOTH the ORDER BY and
 *     the cursor predicate, so the merge key in threads-service and the SQL bound agree.
 *   - unread counts messages from OTHERS strictly after GREATEST(joined_at, last_read_at), using
 *     `IS DISTINCT FROM` (not `<>`) on sender_id: a SYSTEM row has sender_id = NULL and `<>` with a NULL
 *     operand yields NULL, which would silently drop those rows from the count.
 *   - both message reads are served by the chat_messages (<scope>, created_at DESC) partial indexes.
 */
async function listThreadFamily<R extends ThreadFamilyRow>(
  sql: Sql,
  spec: ThreadFamilySpec,
  userId: string,
  limit: number,
  cursor: TimeCursor | null | undefined,
): Promise<R[]> {
  const activity = sql`COALESCE(last_msg.created_at, mem.joined_at)`
  const cursorFilter = threadsCursorFilter(sql, activity, sql`r.id`, cursor)
  const scope = sql(spec.scopeColumn)
  return await sql<R[]>`
    SELECT
      r.id AS room_id,
      ${spec.columns},
      mem.joined_at,
      (SELECT count(*)::int FROM ${sql(spec.memberTable)} m WHERE m.${scope} = r.id) AS members,
      (
        SELECT count(*)::int
        FROM chat_messages cm
        WHERE cm.${scope} = r.id
          AND cm.deleted_at IS NULL
          AND cm.sender_id IS DISTINCT FROM ${userId}
          AND cm.created_at > GREATEST(mem.joined_at, COALESCE(mem.last_read_at, to_timestamp(0)))
      ) AS unread,
      last_msg.body AS last_body,
      last_msg.created_at AS last_created_at,
      last_msg.sender_id AS last_sender_id
    FROM ${sql(spec.memberTable)} mem
    JOIN ${sql(spec.roomTable)} r ON r.id = mem.${scope}
    LEFT JOIN LATERAL (
      SELECT cm.body, cm.created_at, cm.sender_id
      FROM chat_messages cm
      WHERE cm.${scope} = r.id AND cm.deleted_at IS NULL
      ORDER BY cm.created_at DESC, cm.id DESC
      LIMIT 1
    ) last_msg ON TRUE
    WHERE mem.user_id = ${userId}
      ${spec.where ?? sql``}
      ${cursorFilter}
    ORDER BY ${activity} DESC, r.id DESC
    LIMIT ${limit}
  `
}

/** The flattened last-message triple back to the aggregate's nullable `last` object. */
function lastOf(r: ThreadFamilyRow): { body: string | null; createdAt: Date; senderId: string | null } | null {
  return r.last_created_at !== null
    ? { body: r.last_body, createdAt: r.last_created_at, senderId: r.last_sender_id }
    : null
}

const CLEANUP_FAMILY = (sql: Sql): ThreadFamilySpec => ({
  memberTable: "cleanup_members",
  roomTable: "cleanups",
  scopeColumn: "cleanup_id",
  columns: sql`r.title`,
})

const REPORT_FAMILY = (sql: Sql): ThreadFamilySpec => ({
  memberTable: "report_chat_members",
  roomTable: "reports",
  scopeColumn: "report_id",
  columns: sql`r.category, r.addr`,
  // Soft-deleted reports leave no ghost thread.
  where: sql`AND r.deleted_at IS NULL`,
})

const GROUP_FAMILY = (sql: Sql): ThreadFamilySpec => ({
  memberTable: "chat_group_members",
  roomTable: "chat_groups",
  scopeColumn: "group_id",
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
        // ThreadAggregate.last.senderId is non-nullable (cleanup rooms have no sender-less rows today);
        // the unread count above still treats a hypothetical one as "from others".
        last: r.last_created_at !== null
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

/**
 * Report-chat half of the threads inbox. listReportThreadsFor returns the viewer's report chats (via
 * report_chat_members) joined with the report title fields, a member count, a lateral latest-message
 * lookup, and the unread count — one query, newest-activity first. Membership scopes the result: a
 * non-member has no report_chat_members row and so no thread. The watermark is
 * GREATEST(joined_at, last_read_at) off the membership row. Both the latest-message lateral and the
 * unread count are served by chat_messages_report_created_idx (report_id, created_at DESC). Unread uses
 * `IS DISTINCT FROM` (not `<>`) on sender_id because a system message has sender_id = NULL and must
 * still count as "from others" — `<>` with a NULL operand yields NULL and would drop those rows. Report
 * rows with deleted_at set (soft-deleted reports) are excluded so a removed report leaves no ghost
 * thread. `muted` is NOT computed here; the service stamps it from conversation_mutes for all three
 * thread families in one batch lookup.
 */
export function makeDrizzleReportThreadsSource(sql: Sql): ReportThreadsSource {
  return {
    async listReportThreadsFor(
      userId: string,
      limit = 30,
      cursor?: TimeCursor | null,
    ): Promise<ReportThreadAggregateView[]> {
      const rows = await listThreadFamily<
        ThreadFamilyRow & { category: string; addr: string | null }
      >(sql, REPORT_FAMILY(sql), userId, limit, cursor)
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

/**
 * Group-chat half of the threads inbox (P4 4.5). listGroupThreadsFor returns the viewer's groups (via
 * chat_group_members) joined with the group name, a member count, a lateral latest-message lookup, and
 * the unread count — one query, newest-activity first, the exact report-source shape scoped on
 * chat_messages.group_id. The watermark is GREATEST(joined_at, last_read_at) off the membership row
 * (stamped by the WS ack / mark-read-on-open, 4.4). Unread uses `IS DISTINCT FROM` like the report
 * family so a hypothetical sender-less row still counts as "from others". `muted` is NOT computed
 * here; the service stamps it from conversation_mutes ('group') in the shared batch lookup. The group
 * avatar deliberately does not ride here — MessageThreadDTO has no avatar field (UI limitation noted
 * in the service).
 */
export function makeDrizzleGroupThreadsSource(sql: Sql): GroupThreadsSource {
  return {
    async listGroupThreadsFor(
      userId: string,
      limit = 30,
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
