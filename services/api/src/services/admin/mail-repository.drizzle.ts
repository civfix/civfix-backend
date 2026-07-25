
import type { Queryable, Sql } from "../../db/client.js"
import { clampLimit, decodeCursor, encodeCursor } from "./pagination.js"
import { PREVIEW_SOURCE_CHARS } from "./mail-preview.js"
import { writeAudit } from "./audit.js"
import { ilikeAnyOf, type SqlFragment } from "./sql-fragments.js"
import {
  anchorOf,
  mintThreadToken,
  toMessageRecord,
  toOutreachRecord,
  toThreadDTO,
  toThreadListItem,
  toThreadRecord,
  type MessageRowSelect,
  type OutreachRowSelect,
  type ThreadRowSelect,
} from "./mail-mappers.js"
import { buildMailStats } from "./mail-stats.js"
import {
  MAIL_STATS_WINDOW_DAYS,
  type CreateThreadInput,
  type InsertMessageInput,
  type ListThreadsInput,
  type ListThreadsResult,
  type MailAuditInput,
  type MailEventType,
  type MailMessageRecord,
  type MailRepository,
  type MailThreadRecord,
  type OutreachStatePatch,
  type OutreachStateRecord,
  type RecordEventInput,
  type ThreadInit,
} from "./mail-repository.js"
import type { MailDirection, MailStatsResponse, MailStatus, MailThreadDTO } from "@civfix/shared"

export * from "./mail-repository.js"
export {
  anchorOf,
  deriveWho,
  mintThreadToken,
  toMessageDTO,
  toMessageRecord,
  toOutreachRecord,
  toThreadDTO,
  toThreadListItem,
  toThreadRecord,
} from "./mail-mappers.js"
export { buildMailStats } from "./mail-stats.js"

const MAIL_THREAD_MESSAGE_CAP = 500


/** The mail_threads column list every thread read selects, optionally qualified by a table `alias`. */
function threadColumns(sql: Queryable, alias?: string): SqlFragment {
  const p = alias === undefined ? sql`` : sql`${sql(alias)}.`
  return sql`
    ${p}id, ${p}thread_token, ${p}jurisdiction_geoid, ${p}report_id, ${p}cleanup_id, ${p}org,
    ${p}subject, ${p}status, ${p}unread, ${p}last_message_at, ${p}created_at
  `
}

/** The full mail_threads insert tuple (every upsert writes all of it; only the conflict target differs). */
interface ThreadInsertValues {
  threadToken: string
  jurisdictionGeoid: string | null
  reportId: string | null
  cleanupId: string | null
  org: string | null
  subject: string | null
  status: MailStatus
  unread: boolean
}

function threadValues(threadToken: string, init: ThreadInit): ThreadInsertValues {
  return {
    threadToken,
    jurisdictionGeoid: init.jurisdictionGeoid ?? null,
    reportId: init.reportId ?? null,
    cleanupId: init.cleanupId ?? null,
    org: init.org ?? null,
    subject: init.subject ?? null,
    status: init.status ?? "sent",
    unread: init.unread ?? false,
  }
}

/**
 * The find-or-create shape all four thread upserts share: INSERT ... ON CONFLICT DO NOTHING RETURNING,
 * then re-SELECT the row the conflict kept.
 *
 * INVARIANT: `selectWhere` must match exactly the row `onConflict`'s target matched. If the two disagree
 * the fallback SELECT can miss (the "row vanished" throw) or, worse, return a different thread.
 */
async function insertOrSelectThread(
  sql: Sql,
  values: ThreadInsertValues,
  onConflict: SqlFragment,
  selectWhere: SqlFragment,
  label: string,
): Promise<MailThreadRecord> {
  const inserted = await sql<ThreadRowSelect[]>`
    INSERT INTO mail_threads (thread_token, jurisdiction_geoid, report_id, cleanup_id, org, subject, status, unread)
    VALUES (
      ${values.threadToken},
      ${values.jurisdictionGeoid},
      ${values.reportId},
      ${values.cleanupId},
      ${values.org},
      ${values.subject},
      ${values.status},
      ${values.unread}
    )
    ${onConflict}
    RETURNING ${threadColumns(sql)}
  `
  if (inserted[0]) return toThreadRecord(inserted[0])
  const existing = await sql<ThreadRowSelect[]>`
    SELECT ${threadColumns(sql)}
    FROM mail_threads
    WHERE ${selectWhere}
    LIMIT 1
  `
  const row = existing[0]
  if (!row) throw new Error(`${label}: row vanished after conflict`)
  return toThreadRecord(row)
}

export function makeDrizzleMailRepository(sql: Sql): MailRepository {
  return {
    async upsertThreadByToken(token: string, init: ThreadInit = {}): Promise<MailThreadRecord> {
      return insertOrSelectThread(
        sql,
        threadValues(token, init),
        sql`ON CONFLICT (thread_token) DO NOTHING`,
        sql`thread_token = ${token}`,
        "upsertThreadByToken",
      )
    },

    async createThread(input: CreateThreadInput): Promise<MailThreadRecord> {
      const values = threadValues(input.threadToken ?? mintThreadToken(), input)
      const rows = await sql<ThreadRowSelect[]>`
        INSERT INTO mail_threads (thread_token, jurisdiction_geoid, report_id, cleanup_id, org, subject, status, unread)
        VALUES (
          ${values.threadToken},
          ${values.jurisdictionGeoid},
          ${values.reportId},
          ${values.cleanupId},
          ${values.org},
          ${values.subject},
          ${values.status},
          ${values.unread}
        )
        RETURNING ${threadColumns(sql)}
      `
      const row = rows[0]
      if (!row) throw new Error("createThread: insert returned no row")
      return toThreadRecord(row)
    },

    async findOrCreateReportThread(
      reportId: string,
      init: ThreadInit = {},
    ): Promise<MailThreadRecord> {
      return insertOrSelectThread(
        sql,
        { ...threadValues(mintThreadToken(), init), reportId },
        sql`ON CONFLICT (report_id) WHERE report_id IS NOT NULL DO NOTHING`,
        sql`report_id = ${reportId}`,
        "findOrCreateReportThread",
      )
    },

    async findOrCreateEventThread(
      cleanupId: string,
      init: ThreadInit = {},
    ): Promise<MailThreadRecord> {
      return insertOrSelectThread(
        sql,
        { ...threadValues(mintThreadToken(), init), cleanupId },
        sql`ON CONFLICT (cleanup_id) WHERE cleanup_id IS NOT NULL DO NOTHING`,
        sql`cleanup_id = ${cleanupId}`,
        "findOrCreateEventThread",
      )
    },

    async priorOutboundMessageIds(threadId: string): Promise<string[]> {
      const rows = await sql<{ message_id: string }[]>`
        SELECT message_id
        FROM mail_messages
        WHERE thread_id = ${threadId}
          AND direction = 'out'
          AND message_id IS NOT NULL
        ORDER BY created_at ASC, id ASC
      `
      return rows.map((r) => r.message_id)
    },

    async upsertThreadByGeoid(geoid: string, init: ThreadInit = {}): Promise<MailThreadRecord> {
      // A digest thread is the geoid's thread that belongs to NO report and NO event, so both ids are
      // forced null here and the fallback SELECT repeats the partial index's predicate.
      return insertOrSelectThread(
        sql,
        {
          ...threadValues(mintThreadToken(), init),
          jurisdictionGeoid: geoid,
          reportId: null,
          cleanupId: null,
        },
        sql`ON CONFLICT (jurisdiction_geoid) WHERE report_id IS NULL AND cleanup_id IS NULL AND jurisdiction_geoid IS NOT NULL DO NOTHING`,
        sql`jurisdiction_geoid = ${geoid} AND report_id IS NULL AND cleanup_id IS NULL`,
        "upsertThreadByGeoid",
      )
    },

    async findThreadByToken(token: string): Promise<MailThreadRecord | null> {
      const rows = await sql<ThreadRowSelect[]>`
        SELECT ${threadColumns(sql)}
        FROM mail_threads
        WHERE thread_token = ${token}
        LIMIT 1
      `
      return rows[0] ? toThreadRecord(rows[0]) : null
    },

    async findThreadByOutboundMessageIds(
      messageIds: string[],
    ): Promise<MailThreadRecord | null> {
      const ids = messageIds.filter((m) => typeof m === "string" && m.length > 0)
      if (ids.length === 0) return null
      const rows = await sql<ThreadRowSelect[]>`
        SELECT ${threadColumns(sql, "t")}
        FROM mail_threads t
        JOIN mail_messages m ON m.thread_id = t.id
        WHERE m.direction = 'out' AND m.message_id = ANY(${ids}::text[])
        ORDER BY t.last_message_at DESC NULLS LAST, t.created_at DESC, t.id DESC
        LIMIT 1
      `
      return rows[0] ? toThreadRecord(rows[0]) : null
    },

    async insertMessage(input: InsertMessageInput): Promise<MailMessageRecord> {
      const attachments = input.attachments ?? []
      return sql.begin(async (tx) => {
        const inserted = await tx<MessageRowSelect[]>`
          INSERT INTO mail_messages (
            thread_id, direction, from_addr, to_addr, subject, body, attachments, message_id, in_reply_to
          ) VALUES (
            ${input.threadId},
            ${input.direction},
            ${input.fromAddr ?? null},
            ${input.toAddr ?? null},
            ${input.subject ?? null},
            ${input.body ?? null},
            ${tx.json(attachments as Parameters<typeof tx.json>[0])},
            ${input.messageId ?? null},
            ${input.inReplyTo ?? null}
          )
          RETURNING id, thread_id, direction, from_addr, to_addr, subject, body, attachments,
                    message_id, in_reply_to, created_at
        `
        const row = inserted[0]
        if (!row) throw new Error("insertMessage: insert returned no row")
        const setUnread = input.direction === "in"
        await tx`
          UPDATE mail_threads
          SET last_message_at = GREATEST(COALESCE(last_message_at, ${row.created_at}), ${row.created_at}),
              unread = ${setUnread} OR unread
          WHERE id = ${input.threadId}
        `
        if (input.audit) {
          await writeAudit(tx, {
            actorId: input.audit.actorId,
            action: input.audit.action,
            target: input.audit.target,
            meta: input.audit.meta ?? null,
          })
        }
        return toMessageRecord(row)
      })
    },

    async setMessageMessageId(id: string, rfcMessageId: string): Promise<void> {
      await sql`UPDATE mail_messages SET message_id = ${rfcMessageId} WHERE id = ${id}`
    },

    async listThreads(input: ListThreadsInput): Promise<ListThreadsResult> {
      const limit = clampLimit(input.limit)
      const anchor = decodeCursor(input.cursor, true)
      const cursorFilter =
        anchor !== null
          ? sql`AND (COALESCE(t.last_message_at, t.created_at), t.id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
          : sql``
      const geoidFilter =
        input.jurisdictionGeoid !== undefined
          ? sql`AND t.jurisdiction_geoid = ${input.jurisdictionGeoid}`
          : sql``
      const attnFilter =
        input.filter === "attn"
          ? sql`AND (t.unread = true OR t.status IN ('needs_action', 'bounced'))`
          : sql``
      const dirFilter = input.dir !== undefined ? sql`AND lm.direction = ${input.dir}` : sql``
      const qFilter =
        input.q !== undefined && input.q.trim().length > 0
          ? sql`AND ${ilikeAnyOf(sql, [sql`t.org`, sql`t.subject`, sql`lm.from_addr`], input.q.trim())}`
          : sql``
      const rows = await sql<
        (ThreadRowSelect & {
          lm_direction: MailDirection | null
          lm_from_addr: string | null
          lm_to_addr: string | null
          lm_body: string | null
        })[]
      >`
        SELECT ${threadColumns(sql, "t")},
               lm.direction AS lm_direction, lm.from_addr AS lm_from_addr, lm.to_addr AS lm_to_addr,
               lm.body AS lm_body
        FROM mail_threads t
        LEFT JOIN LATERAL (
          -- Only a preview's worth of the latest body: a municipal reply can be tens of KB and this is a
          -- page of them (toThreadListItem truncates to the shared preview length anyway).
          SELECT direction, from_addr, to_addr, left(body, ${PREVIEW_SOURCE_CHARS}) AS body
          FROM mail_messages m
          WHERE m.thread_id = t.id
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
        ) lm ON true
        WHERE true
          ${geoidFilter}
          ${attnFilter}
          ${dirFilter}
          ${qFilter}
          ${cursorFilter}
        ORDER BY COALESCE(t.last_message_at, t.created_at) DESC, t.id DESC
        LIMIT ${limit + 1}
      `
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const items = page.map((r) => {
        const thread = toThreadRecord(r)
        const latest: MailMessageRecord | null =
          r.lm_direction !== null
            ? {
                id: "",
                threadId: r.id,
                direction: r.lm_direction,
                fromAddr: r.lm_from_addr,
                toAddr: r.lm_to_addr,
                subject: null,
                body: r.lm_body,
                attachments: [],
                messageId: null,
                inReplyTo: null,
                createdAt: thread.lastMessageAt ?? thread.createdAt,
              }
            : null
        return toThreadListItem(thread, latest)
      })
      const last = page[page.length - 1]
      const nextCursor = hasMore && last ? encodeCursor(anchorOf(toThreadRecord(last))) : null
      return { items, nextCursor }
    },

    async getThread(id: string): Promise<MailThreadDTO | null> {
      const threads = await sql<ThreadRowSelect[]>`
        SELECT ${threadColumns(sql)}
        FROM mail_threads
        WHERE id = ${id}
        LIMIT 1
      `
      const threadRow = threads[0]
      if (!threadRow) return null
      const messages = await sql<MessageRowSelect[]>`
        SELECT id, thread_id, direction, from_addr, to_addr, subject, body, attachments, message_id,
               in_reply_to, created_at
        FROM (
          SELECT id, thread_id, direction, from_addr, to_addr, subject, body, attachments, message_id,
                 in_reply_to, created_at
          FROM mail_messages
          WHERE thread_id = ${id}
          ORDER BY created_at DESC, id DESC
          LIMIT ${MAIL_THREAD_MESSAGE_CAP}
        ) recent
        ORDER BY created_at ASC, id ASC
      `
      return toThreadDTO(toThreadRecord(threadRow), messages.map(toMessageRecord))
    },

    async getThreadRecord(id: string): Promise<MailThreadRecord | null> {
      const rows = await sql<ThreadRowSelect[]>`
        SELECT ${threadColumns(sql)}
        FROM mail_threads
        WHERE id = ${id}
        LIMIT 1
      `
      return rows[0] ? toThreadRecord(rows[0]) : null
    },

    async outboundRecipients(threadId: string): Promise<string[]> {
      const rows = await sql<{ to_addr: string }[]>`
        SELECT DISTINCT to_addr
        FROM mail_messages
        WHERE thread_id = ${threadId}
          AND direction = 'out'
          AND to_addr IS NOT NULL
          AND to_addr <> ''
      `
      return rows.map((r) => r.to_addr)
    },

    async getLastOutboundRecipient(threadId: string): Promise<string | null> {
      const rows = await sql<{ to_addr: string | null }[]>`
        SELECT to_addr
        FROM mail_messages
        WHERE thread_id = ${threadId}
          AND direction = 'out'
          AND to_addr IS NOT NULL
          AND to_addr <> ''
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
      return rows[0]?.to_addr ?? null
    },

    async messageExists(messageId: string): Promise<boolean> {
      const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM mail_messages WHERE message_id = ${messageId}) AS exists
      `
      return rows[0]?.exists ?? false
    },

    async markThreadRead(id: string): Promise<boolean> {
      const rows = await sql<{ id: string }[]>`
        UPDATE mail_threads SET unread = false WHERE id = ${id} RETURNING id
      `
      return rows.length > 0
    },

    async setThreadStatus(id: string, status: MailStatus, audit?: MailAuditInput): Promise<boolean> {
      return sql.begin(async (tx) => {
        const rows = await tx<{ id: string }[]>`
          UPDATE mail_threads SET status = ${status} WHERE id = ${id} RETURNING id
        `
        if (rows.length === 0) return false
        if (audit) {
          await writeAudit(tx, {
            actorId: audit.actorId,
            action: audit.action,
            target: audit.target,
            meta: audit.meta ?? null,
          })
        }
        return true
      })
    },

    async recordEvent(input: RecordEventInput): Promise<string> {
      const meta = sql.json((input.meta ?? {}) as Parameters<typeof sql.json>[0])
      const rows = await sql<{ id: string }[]>`
        INSERT INTO mail_events (thread_id, message_id, type, meta)
        VALUES (${input.threadId ?? null}, ${input.messageId ?? null}, ${input.type}, ${meta})
        RETURNING id
      `
      const id = rows[0]?.id
      if (id === undefined) throw new Error("recordEvent: insert returned no row")
      return id
    },

    async stats7d(): Promise<MailStatsResponse> {
      const eventRows = await sql<{ type: MailEventType; n: string }[]>`
        SELECT type, COUNT(*)::text AS n
        FROM mail_events
        WHERE created_at >= now() - make_interval(days => ${MAIL_STATS_WINDOW_DAYS})
        GROUP BY type
      `
      const counts = { sent: 0, bounced: 0, failed: 0 }
      for (const row of eventRows) {
        const n = Number.parseInt(row.n, 10)
        if (row.type in counts) counts[row.type as keyof typeof counts] = Number.isNaN(n) ? 0 : n
      }
      const mailbox = await sql<{ unread: string; threads: string }[]>`
        SELECT
          COUNT(*) FILTER (WHERE unread = true)::text AS unread,
          COUNT(*)::text AS threads
        FROM mail_threads
      `
      const unread = Number.parseInt(mailbox[0]?.unread ?? "0", 10)
      const threads = Number.parseInt(mailbox[0]?.threads ?? "0", 10)
      return buildMailStats({
        unread: Number.isNaN(unread) ? 0 : unread,
        threads: Number.isNaN(threads) ? 0 : threads,
        counts,
      })
    },

    async getOutreachState(geoid: string): Promise<OutreachStateRecord | null> {
      const rows = await sql<OutreachRowSelect[]>`
        SELECT geoid, last_outreach_at, suppressed
        FROM outreach_state
        WHERE geoid = ${geoid}
        LIMIT 1
      `
      return rows[0] ? toOutreachRecord(rows[0]) : null
    },

    async setOutreachState(geoid: string, patch: OutreachStatePatch): Promise<OutreachStateRecord> {
      // OMITTED (undefined) keeps the stored value; an explicit null CLEARS it (a throttle reset, e.g. the
      // outreach service rolling back a claim whose send failed). COALESCE cannot tell those apart — it
      // treated a clear as "keep", so the reset silently no-op'd against Postgres while passing against the
      // in-memory repo, which has always distinguished them. The provided-flags mirror the
      // jurisdiction forward-template CASEs.
      const setLastOutreachAt = patch.lastOutreachAt !== undefined
      const lastOutreachAt = patch.lastOutreachAt ?? null
      const setSuppressed = patch.suppressed !== undefined
      const suppressed = patch.suppressed ?? false
      const rows = await sql<OutreachRowSelect[]>`
        INSERT INTO outreach_state (geoid, last_outreach_at, suppressed)
        VALUES (${geoid}, ${lastOutreachAt}, ${suppressed})
        ON CONFLICT (geoid) DO UPDATE SET
          last_outreach_at = CASE
            WHEN ${setLastOutreachAt} THEN ${lastOutreachAt}
            ELSE outreach_state.last_outreach_at
          END,
          suppressed = CASE
            WHEN ${setSuppressed} THEN ${suppressed}
            ELSE outreach_state.suppressed
          END
        RETURNING geoid, last_outreach_at, suppressed
      `
      const row = rows[0]
      if (!row) throw new Error("setOutreachState: upsert returned no row")
      return toOutreachRecord(row)
    },
  }
}
