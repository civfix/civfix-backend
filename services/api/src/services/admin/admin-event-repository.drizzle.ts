import type { Sql } from "../../db/client.js"
import { decodeCursor, clampLimit, keysetPredicate, paginateKeyset } from "./pagination.js"
import { writeAudit } from "./audit.js"
import { adminEventStatusExpr } from "../cleanup-sql.js"
import {
  eventSelect,
  flaggedEventExpr,
  searchEventsFragment,
  toRecord,
  type EventRowSelect,
} from "./admin-event-sql.js"
import { ADMIN_EVENT_MESSAGE_CAP, eventOutcomeNote } from "./admin-event-helpers.js"
import { andAll, type SqlFragment } from "./sql-fragments.js"
import { publicReportFilter } from "../report-sql.js"
import { CIVFIX_OFFICIAL_USER_ID } from "../../auth/official-account.js"
import type {
  AdminEventMessageRecord,
  AdminEventRecord,
  AdminEventRepository,
  AdminEventTimelineRecord,
  ListEventsArgs,
} from "./admin-event-service.js"
import type { LinkedReportView } from "../cleanup-service.js"
import type { AdminEventCounts, ReportCategory, ReportStatus } from "@civfix/shared"

const LINK_REPORTS_MAX = 100

export function makeDrizzleAdminEventRepository(sql: Sql): AdminEventRepository {
  return {
    async listEvents(
      args: ListEventsArgs,
    ): Promise<{ records: AdminEventRecord[]; nextCursor: string | null }> {
      const limit = clampLimit(args.limit)
      const anchor = decodeCursor(args.cursor, true)

      const conds: SqlFragment[] = []
      if (args.status !== null) {
        conds.push(sql`AND ${adminEventStatusExpr(sql)} = ${args.status}`)
      }
      if (args.flaggedOnly) conds.push(sql`AND ${flaggedEventExpr(sql)}`)
      if (args.q !== null) conds.push(searchEventsFragment(sql, args.q))
      if (args.organizationId !== undefined) {
        conds.push(sql`AND c.organization_id = ${args.organizationId}::uuid`)
      }
      if (args.when !== undefined) {
        conds.push(
          args.when.kind === "upcoming"
            ? sql`AND c.status <> 'cancelled' AND c.ends_at > ${args.when.ref}`
            : sql`AND (c.ends_at <= ${args.when.ref} OR c.status = 'cancelled')`,
        )
      }
      if (anchor !== null) {
        conds.push(sql`AND ${keysetPredicate(sql, sql`c.scheduled_at`, sql`c.id`, anchor)}`)
      }
      const extraWhere = andAll(sql, conds)
      const orderLimit = sql`ORDER BY c.scheduled_at DESC, c.id DESC LIMIT ${limit + 1}`

      const rows = (await eventSelect(sql, extraWhere, orderLimit)) as unknown as EventRowSelect[]
      const { items, nextCursor } = paginateKeyset(rows, limit, (r) => ({
        atText: r.cursor_at,
        id: r.id,
      }))
      return { records: items.map(toRecord), nextCursor }
    },

    async countByBucket(args: { q: string | null }): Promise<AdminEventCounts> {
      const search = searchEventsFragment(sql, args.q)
      const rows = await sql<
        { all: string; upcoming: string; in_progress: string; completed: string; flagged: string }[]
      >`
        WITH candidates AS (
          SELECT ${adminEventStatusExpr(sql)} AS status, ${flaggedEventExpr(sql)} AS flagged
          FROM cleanups c
          LEFT JOIN users u ON u.id = c.organizer_user_id
          WHERE true
          ${search}
        )
        SELECT
          COUNT(*)::text AS all,
          COUNT(*) FILTER (WHERE status = 'upcoming')::text AS upcoming,
          COUNT(*) FILTER (WHERE status = 'in_progress')::text AS in_progress,
          COUNT(*) FILTER (WHERE status = 'completed')::text AS completed,
          COUNT(*) FILTER (WHERE flagged)::text AS flagged
        FROM candidates
      `
      const r = rows[0]
      return {
        all: Number(r?.all ?? "0"),
        upcoming: Number(r?.upcoming ?? "0"),
        in_progress: Number(r?.in_progress ?? "0"),
        completed: Number(r?.completed ?? "0"),
        flagged: Number(r?.flagged ?? "0"),
      }
    },

    async getEvent(id: string): Promise<AdminEventRecord | null> {
      const rows = (await eventSelect(
        sql,
        sql`AND c.id = ${id}`,
        sql`LIMIT 1`,
      )) as unknown as EventRowSelect[]
      return rows[0] ? toRecord(rows[0]) : null
    },

    async listTimeline(id: string): Promise<AdminEventTimelineRecord[]> {
      const rows = await sql<
        { kind: string; note: string | null; who: string | null; created_at: Date }[]
      >`
        SELECT t.kind, t.note, COALESCE(u.display_name, u.handle) AS who, t.created_at
        FROM cleanup_timeline t
        LEFT JOIN users u ON u.id = t.actor_id
        WHERE t.cleanup_id = ${id}
        ORDER BY t.created_at ASC, t.id ASC
      `
      return rows.map((r) => ({
        kind: r.kind,
        note: r.note,
        who: r.who ?? "system",
        createdAt: r.created_at,
      }))
    },

    async listMessages(id: string): Promise<AdminEventMessageRecord[]> {
      const rows = await sql<{ who: string | null; body: string | null; created_at: Date }[]>`
        SELECT COALESCE(u.display_name, u.handle) AS who, m.body, m.created_at
        FROM chat_messages m
        LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.cleanup_id = ${id} AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${ADMIN_EVENT_MESSAGE_CAP}
      `
      return rows.reverse().map((r) => ({
        who: r.who ?? "system",
        text: r.body ?? "",
        createdAt: r.created_at,
      }))
    },

    async setBags(id: string, input: { bags: number; actorId: string | null }): Promise<boolean> {
      return sql.begin(async (tx) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE cleanups SET bags = ${input.bags} WHERE id = ${id} RETURNING id
        `
        if (updated.length === 0) return false
        await tx`
          INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
          VALUES (${id}, 'outcome', ${eventOutcomeNote(input.bags)}, ${input.actorId})
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "event.outcome_logged",
          target: `cleanup:${id}`,
          meta: { bags: input.bags },
        })
        return true
      })
    },

    async toggleFlag(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<boolean | null> {
      return sql.begin(async (tx) => {
        const exists = await tx<{ id: string }[]>`
          SELECT id FROM cleanups WHERE id = ${id} FOR NO KEY UPDATE
        `
        if (exists.length === 0) return null

        const latest = await tx<{ kind: string }[]>`
          SELECT kind FROM cleanup_timeline
          WHERE cleanup_id = ${id} AND kind IN ('flag', 'unflag')
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `
        const currentlyFlagged = latest[0]?.kind === "flag"
        const nowFlagged = !currentlyFlagged
        await tx`
          INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
          VALUES (
            ${id}, ${nowFlagged ? "flag" : "unflag"},
            ${nowFlagged ? "Flagged for review" : "Flag cleared"},
            ${input.actorId}
          )
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: nowFlagged ? "event.flagged" : "event.unflagged",
          target: `cleanup:${id}`,
          meta: { reason: input.reason },
        })
        return nowFlagged
      })
    },

    async cancel(id: string, input: { note: string; actorId: string | null }): Promise<boolean> {
      return sql.begin(async (tx) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE cleanups SET status = 'cancelled'
          WHERE id = ${id} AND status <> 'cancelled'
          RETURNING id
        `
        if (updated.length === 0) {
          const existing = await tx<{ id: string }[]>`
            SELECT id FROM cleanups WHERE id = ${id} LIMIT 1
          `
          return existing.length > 0
        }
        await tx`
          INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
          VALUES (${id}, 'cancel', ${input.note}, ${input.actorId})
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "event.cancelled",
          target: `cleanup:${id}`,
          meta: { note: input.note },
        })
        return true
      })
    },

    async postMessage(
      id: string,
      input: { body: string; actorId: string },
    ): Promise<{ notified: number } | null> {
      return sql.begin(async (tx) => {
        const exists = await tx<{ id: string }[]>`SELECT id FROM cleanups WHERE id = ${id} LIMIT 1`
        if (exists.length === 0) return null
        const [message] = await tx<{ id: string }[]>`
          INSERT INTO chat_messages (cleanup_id, sender_id, body, kind)
          VALUES (${id}, ${CIVFIX_OFFICIAL_USER_ID}, ${input.body}, 'text')
          RETURNING id
        `
        await tx`
          INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
          VALUES (${id}, 'message', 'Posted an update to attendees', ${input.actorId})
        `
        const notified = await tx<{ user_id: string }[]>`
          INSERT INTO notifications (user_id, type, title, body, link)
          SELECT cm.user_id, 'cleanup_chat', 'Cleanup update', ${input.body}, ${`/cleanups/${id}`}
          FROM cleanup_members cm
          WHERE cm.cleanup_id = ${id}
          RETURNING user_id
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "event.message_posted",
          target: `cleanup:${id}`,
          meta: { members: notified.length, messageId: message!.id },
        })
        return { notified: notified.length }
      })
    },

    async loadLinkedReports(id: string): Promise<LinkedReportView[]> {
      const rows = await sql<
        {
          id: string
          category: ReportCategory
          title: string | null
          status: ReportStatus
          lng: number
          lat: number
          addr: string | null
          thumb_key: string | null
          linked_at: Date
        }[]
      >`
        SELECT
          r.id,
          r.category,
          r.title,
          r.status,
          ST_X(r.geom) AS lng,
          ST_Y(r.geom) AS lat,
          r.addr,
          m.thumb_key,
          cr.linked_at
        FROM cleanup_reports cr
        JOIN reports r ON r.id = cr.report_id
        LEFT JOIN LATERAL (
          SELECT COALESCE(ma.thumb_key, ma.served_key) AS thumb_key
          FROM media_assets ma
          WHERE ma.report_id = r.id AND ma.status = 'ready'
            AND (ma.thumb_key IS NOT NULL OR ma.served_key IS NOT NULL)
          ORDER BY ma.created_at ASC
          LIMIT 1
        ) m ON true
        WHERE cr.cleanup_id = ${id}
          AND ${publicReportFilter(sql)}
        ORDER BY cr.linked_at DESC, r.id
      `
      return rows.map((r) => ({
        cleanupId: id,
        id: r.id,
        category: r.category,
        title: r.title,
        status: r.status,
        lat: r.lat,
        lng: r.lng,
        addr: r.addr,
        thumbKey: r.thumb_key,
        linkedAt: r.linked_at,
      }))
    },

    async linkReports(
      id: string,
      reportIds: string[],
      actorId: string | null,
    ): Promise<{ linked: string[] } | null> {
      return sql.begin(async (tx) => {
        const exists = await tx<{ id: string }[]>`SELECT id FROM cleanups WHERE id = ${id} LIMIT 1`
        if (exists.length === 0) return null
        const ids = reportIds.slice(0, LINK_REPORTS_MAX)
        const insertedRows =
          ids.length === 0
            ? []
            : await tx<{ report_id: string }[]>`
                INSERT INTO cleanup_reports (cleanup_id, report_id, linked_by_user_id)
                SELECT ${id}, r.id, ${actorId}
                FROM reports r
                WHERE r.id = ANY(${ids}::uuid[])
                  AND ${publicReportFilter(tx)}
                ON CONFLICT (cleanup_id, report_id) DO NOTHING
                RETURNING report_id
              `
        const linked = insertedRows.map((r) => r.report_id)
        if (linked.length > 0) {
          await tx`
            INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
            SELECT ${id}, 'report_linked', 'Linked report ' || rid::text, ${actorId}
            FROM unnest(${linked}::uuid[]) AS rid
          `
        }
        await writeAudit(tx, {
          actorId,
          action: "event.reports_linked",
          target: `cleanup:${id}`,
          meta: { reportIds: linked },
        })
        return { linked }
      })
    },

    async unlinkReport(
      id: string,
      reportId: string,
      actorId: string | null,
    ): Promise<boolean | null> {
      return sql.begin(async (tx) => {
        const exists = await tx<{ id: string }[]>`SELECT id FROM cleanups WHERE id = ${id} LIMIT 1`
        if (exists.length === 0) return null
        const removed = await tx<{ id: string }[]>`
          DELETE FROM cleanup_reports
          WHERE cleanup_id = ${id} AND report_id = ${reportId}
          RETURNING id
        `
        if (removed.length === 0) return false
        await tx`
          INSERT INTO cleanup_timeline (cleanup_id, kind, note, actor_id)
          VALUES (${id}, 'report_unlinked', ${`Unlinked report ${reportId}`}, ${actorId})
        `
        await writeAudit(tx, {
          actorId,
          action: "event.report_unlinked",
          target: `cleanup:${id}`,
          meta: { reportId },
        })
        return true
      })
    },
  }
}
