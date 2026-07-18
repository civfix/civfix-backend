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
import type { Sql } from "../db/client.js"
import type {
  GroupThreadAggregateView,
  GroupThreadsSource,
  ReportThreadAggregateView,
  ReportThreadsSource,
  ThreadAggregate,
  ThreadsRepository,
} from "./threads-service.js"

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

/** Selected report-thread aggregate row (member's report + last-message + members + unread). */
interface ReportThreadRowSelect {
  report_id: string
  category: string
  addr: string | null
  joined_at: Date
  members: number
  unread: number
  last_body: string | null
  last_created_at: Date | null
  last_sender_id: string | null
}

/** Selected group-thread aggregate row (member's group + last-message + members + unread). */
interface GroupThreadRowSelect {
  group_id: string
  name: string
  kind: "group" | "channel"
  joined_at: Date
  members: number
  unread: number
  last_body: string | null
  last_created_at: Date | null
  last_sender_id: string | null
}

/** Selected thread aggregate row (member's cleanup + last-message + unread fields). */
interface ThreadRowSelect {
  cleanup_id: string
  title: string
  joined_at: Date
  members: number
  unread: number
  last_body: string | null
  last_created_at: Date | null
  last_sender_id: string | null
}

export function makeDrizzleThreadsRepository(sql: Sql): ThreadsRepository {
  return {
    async listThreadsFor(userId: string, limit: number): Promise<ThreadAggregate[]> {
      const rows = await sql<ThreadRowSelect[]>`
        SELECT
          c.id AS cleanup_id,
          c.title,
          mem.joined_at,
          (SELECT count(*)::int FROM cleanup_members m WHERE m.cleanup_id = c.id) AS members,
          -- Unread = messages from OTHERS strictly after the viewer's watermark (max of joined_at and the
          -- durable last_read_at the WS 'ack' handler stamps). Correlated count(*) served by
          -- chat_messages_cleanup_created_idx (cleanup_id, created_at DESC); folding it here replaces the
          -- former per-thread countUnread fan-out so the inbox is a single round-trip regardless of N.
          (
            SELECT count(*)::int
            FROM chat_messages cm
            WHERE cm.cleanup_id = c.id
              AND cm.deleted_at IS NULL
              AND cm.sender_id <> ${userId}
              AND cm.created_at > GREATEST(mem.joined_at, COALESCE(mem.last_read_at, to_timestamp(0)))
          ) AS unread,
          last_msg.body AS last_body,
          last_msg.created_at AS last_created_at,
          last_msg.sender_id AS last_sender_id
        FROM cleanup_members mem
        JOIN cleanups c ON c.id = mem.cleanup_id
        LEFT JOIN LATERAL (
          SELECT cm.body, cm.created_at, cm.sender_id
          FROM chat_messages cm
          WHERE cm.cleanup_id = c.id AND cm.deleted_at IS NULL
          ORDER BY cm.created_at DESC, cm.id DESC
          LIMIT 1
        ) last_msg ON TRUE
        WHERE mem.user_id = ${userId}
        ORDER BY COALESCE(last_msg.created_at, mem.joined_at) DESC
        LIMIT ${limit}
      `
      return rows.map((r) => ({
        cleanupId: r.cleanup_id,
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
          AND cm.sender_id <> ${userId}
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
    async listReportThreadsFor(userId: string, limit = 30): Promise<ReportThreadAggregateView[]> {
      const rows = await sql<ReportThreadRowSelect[]>`
        SELECT
          r.id AS report_id,
          r.category,
          r.addr,
          mem.joined_at,
          (SELECT count(*)::int FROM report_chat_members m WHERE m.report_id = r.id) AS members,
          -- Unread = messages from OTHERS strictly after the viewer's watermark (max of joined_at and
          -- the durable last_read_at). IS DISTINCT FROM keeps sender-less system rows counted.
          (
            SELECT count(*)::int
            FROM chat_messages cm
            WHERE cm.report_id = r.id
              AND cm.deleted_at IS NULL
              AND cm.sender_id IS DISTINCT FROM ${userId}
              AND cm.created_at > GREATEST(mem.joined_at, COALESCE(mem.last_read_at, to_timestamp(0)))
          ) AS unread,
          last_msg.body AS last_body,
          last_msg.created_at AS last_created_at,
          last_msg.sender_id AS last_sender_id
        FROM report_chat_members mem
        JOIN reports r ON r.id = mem.report_id
        LEFT JOIN LATERAL (
          SELECT cm.body, cm.created_at, cm.sender_id
          FROM chat_messages cm
          WHERE cm.report_id = r.id AND cm.deleted_at IS NULL
          ORDER BY cm.created_at DESC, cm.id DESC
          LIMIT 1
        ) last_msg ON TRUE
        WHERE mem.user_id = ${userId}
          AND r.deleted_at IS NULL
        ORDER BY COALESCE(last_msg.created_at, mem.joined_at) DESC
        LIMIT ${limit}
      `
      return rows.map((r) => ({
        reportId: r.report_id,
        title: reportThreadTitle(r.category, r.addr),
        members: r.members,
        unread: r.unread,
        joinedAt: r.joined_at,
        last:
          r.last_created_at !== null
            ? { body: r.last_body, createdAt: r.last_created_at, senderId: r.last_sender_id }
            : null,
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
    async listGroupThreadsFor(userId: string, limit = 30): Promise<GroupThreadAggregateView[]> {
      const rows = await sql<GroupThreadRowSelect[]>`
        SELECT
          g.id AS group_id,
          g.name,
          g.kind,
          mem.joined_at,
          (SELECT count(*)::int FROM chat_group_members m WHERE m.group_id = g.id) AS members,
          -- Unread = messages from OTHERS strictly after the viewer's watermark (max of joined_at and
          -- the durable last_read_at the WS 'ack'/mark-read-on-open stamp).
          (
            SELECT count(*)::int
            FROM chat_messages cm
            WHERE cm.group_id = g.id
              AND cm.deleted_at IS NULL
              AND cm.sender_id IS DISTINCT FROM ${userId}
              AND cm.created_at > GREATEST(mem.joined_at, COALESCE(mem.last_read_at, to_timestamp(0)))
          ) AS unread,
          last_msg.body AS last_body,
          last_msg.created_at AS last_created_at,
          last_msg.sender_id AS last_sender_id
        FROM chat_group_members mem
        JOIN chat_groups g ON g.id = mem.group_id
        LEFT JOIN LATERAL (
          SELECT cm.body, cm.created_at, cm.sender_id
          FROM chat_messages cm
          WHERE cm.group_id = g.id AND cm.deleted_at IS NULL
          ORDER BY cm.created_at DESC, cm.id DESC
          LIMIT 1
        ) last_msg ON TRUE
        WHERE mem.user_id = ${userId}
        ORDER BY COALESCE(last_msg.created_at, mem.joined_at) DESC
        LIMIT ${limit}
      `
      return rows.map((r) => ({
        groupId: r.group_id,
        title: r.name,
        kind: r.kind,
        members: r.members,
        unread: r.unread,
        joinedAt: r.joined_at,
        last:
          r.last_created_at !== null
            ? { body: r.last_body, createdAt: r.last_created_at, senderId: r.last_sender_id }
            : null,
      }))
    },
  }
}
