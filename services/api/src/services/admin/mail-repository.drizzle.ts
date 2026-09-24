import type { Queryable, Sql } from "../../db/client.js"
import {
  clampLimit,
  decodeCursor,
  keysetInstant,
  keysetPredicate,
  paginateKeyset,
} from "./pagination.js"
import { PREVIEW_SOURCE_CHARS } from "./mail-preview.js"
import { writeAudit } from "./audit.js"
import { ilikeAnyOf, type SqlFragment } from "./sql-fragments.js"
import {
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
import { parseCount } from "./category-counts.js"
import { sendInFlightExpr } from "./outbound-send-sql.js"
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
  type OutboundMessageSnapshot,
  type OutreachStatePatch,
  type OutreachStateRecord,
  BOUNCE_DISCOVERY_PENDING_META_KEY,
  type BounceEventKey,
  type BounceEventState,
  type ClaimEffectsInput,
  type PendingEffects,
  type PendingEffectsQuery,
  type RecordEventInput,
  type RecordSendFailureInput,
  type SettleRepliedThreadInput,
  type SettleThreadStatusInput,
  type ThreadInit,
} from "./mail-repository.js"
import type { MailDirection, MailStatsResponse, MailStatus, MailThreadDTO } from "@civfix/shared"

export * from "./mail-repository.js"
export { deriveWho, mintThreadToken, toThreadDTO } from "./mail-mappers.js"
export { buildMailStats } from "./mail-stats.js"

const MAIL_THREAD_MESSAGE_CAP = 500

export const MAIL_BODY_DETAIL_CHARS = 64 * 1024

const PRIOR_OUTBOUND_ID_WINDOW = 20

interface PendingEffectsRowSelect extends MessageRowSelect {
  t_id: string
  t_thread_token: string
  t_jurisdiction_geoid: string | null
  t_report_id: string | null
  t_cleanup_id: string | null
  t_org: string | null
  t_subject: string | null
  t_status: MailStatus
  t_unread: boolean
  t_last_message_at: Date | null
  t_created_at: Date
}

function messageColumns(sql: Queryable): SqlFragment {
  return sql`
    id, thread_id, direction, from_addr, to_addr, subject,
    left(body, ${MAIL_BODY_DETAIL_CHARS}) AS body,
    kind, attachments, message_id, in_reply_to, unaffiliated, effects_claimed_at,
    effects_applied_at, effects_stage, auth_verdict, created_at
  `
}

function withheldReplyExpr(sql: Queryable, threadId: string): SqlFragment {
  return sql`EXISTS (
    SELECT 1
    FROM mail_messages m
    JOIN mail_threads t ON t.id = m.thread_id
    WHERE m.thread_id = ${threadId}
      AND m.direction = 'in'
      AND m.unaffiliated = true
      AND m.effects_applied_at IS NULL
      AND (t.report_id IS NOT NULL OR t.cleanup_id IS NOT NULL)
  )`
}

async function settleThreadStatusIn(tx: Queryable, input: SettleThreadStatusInput): Promise<void> {
  await tx`SELECT id FROM mail_threads WHERE id = ${input.threadId} FOR UPDATE`
  const settled = await tx<{ id: string }[]>`
    UPDATE mail_threads
    SET status = CASE
      WHEN ${input.flag !== undefined}
        OR (status = 'needs_action' AND ${withheldReplyExpr(tx, input.threadId)})
        THEN 'needs_action'
      ELSE 'replied'
    END
    WHERE id = ${input.threadId}
    RETURNING id
  `
  if (settled.length === 0 || input.flag === undefined) return
  await writeAudit(tx, {
    actorId: input.flag.actorId,
    action: input.flag.action,
    target: input.flag.target,
    meta: input.flag.meta ?? null,
  })
}

function threadColumns(sql: Queryable, alias?: string): SqlFragment {
  const p = alias === undefined ? sql`` : sql`${sql(alias)}.`
  return sql`
    ${p}id, ${p}thread_token, ${p}jurisdiction_geoid, ${p}report_id, ${p}cleanup_id, ${p}org,
    ${p}subject, ${p}status, ${p}unread, ${p}last_message_at, ${p}created_at
  `
}

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

interface ThreadListRowSelect extends ThreadRowSelect {
  lm_direction: MailDirection | null
  lm_from_addr: string | null
  lm_to_addr: string | null
  lm_body: string | null
}

function latestPreviewMessage(
  r: ThreadListRowSelect,
  thread: MailThreadRecord,
): MailMessageRecord | null {
  if (r.lm_direction === null) return null
  return {
    id: "",
    threadId: r.id,
    direction: r.lm_direction,
    fromAddr: r.lm_from_addr,
    toAddr: r.lm_to_addr,
    subject: null,
    body: r.lm_body,
    html: null,
    kind: null,
    attachments: [],
    messageId: null,
    inReplyTo: null,
    unaffiliated: false,
    effectsClaimedAt: null,
    effectsAppliedAt: null,
    effectsStage: 0,
    authVerdict: null,
    createdAt: thread.lastMessageAt ?? thread.createdAt,
  }
}

async function writeMailAudit(tx: Queryable, audit: MailAuditInput | undefined): Promise<void> {
  if (!audit) return
  await writeAudit(tx, {
    actorId: audit.actorId,
    action: audit.action,
    target: audit.target,
    meta: audit.meta ?? null,
  })
}

function bounceEventMatch(sql: Queryable, input: BounceEventKey): SqlFragment {
  return sql`
    thread_id = ${input.threadId}::uuid
    AND type = 'bounced'
    AND meta->>'originalMessageId' = ${input.originalMessageId}
    AND lower(meta->>'failedRecipient') = lower(${input.failedRecipient})
  `
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

    async findReportThread(reportId: string): Promise<MailThreadRecord | null> {
      const rows = await sql<ThreadRowSelect[]>`
        SELECT ${threadColumns(sql)}
        FROM mail_threads
        WHERE report_id = ${reportId}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
      return rows[0] ? toThreadRecord(rows[0]) : null
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
        FROM (
          (
            SELECT message_id, created_at, id
            FROM mail_messages
            WHERE thread_id = ${threadId} AND direction = 'out' AND message_id IS NOT NULL
            ORDER BY created_at ASC, id ASC
            LIMIT 1
          )
          UNION
          (
            SELECT message_id, created_at, id
            FROM mail_messages
            WHERE thread_id = ${threadId} AND direction = 'out' AND message_id IS NOT NULL
            ORDER BY created_at DESC, id DESC
            LIMIT ${PRIOR_OUTBOUND_ID_WINDOW}
          )
        ) u
        ORDER BY created_at ASC, id ASC
      `
      return rows.map((r) => r.message_id)
    },

    async upsertThreadByGeoid(geoid: string, init: ThreadInit = {}): Promise<MailThreadRecord> {
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

    async findThreadByOutboundMessageIds(messageIds: string[]): Promise<MailThreadRecord | null> {
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

    async insertMessage(input: InsertMessageInput): Promise<MailMessageRecord | null> {
      const attachments = input.attachments ?? []
      return sql.begin(async (tx) => {
        const inserted = await tx<MessageRowSelect[]>`
          INSERT INTO mail_messages (
            thread_id, direction, from_addr, to_addr, subject, body, html, kind, attachments,
            message_id, in_reply_to, unaffiliated, auth_verdict
          ) VALUES (
            ${input.threadId},
            ${input.direction},
            ${input.fromAddr ?? null},
            ${input.toAddr ?? null},
            ${input.subject ?? null},
            ${input.body ?? null},
            ${input.html ?? null},
            ${input.kind ?? null},
            ${tx.json(attachments as Parameters<typeof tx.json>[0])},
            ${input.messageId ?? null},
            ${input.inReplyTo ?? null},
            ${input.unaffiliated ?? false},
            ${input.authVerdict ?? null}
          )
          ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING
          RETURNING id, thread_id, direction, from_addr, to_addr, subject, body, html, kind,
                    attachments, message_id, in_reply_to, unaffiliated, effects_claimed_at,
                    effects_applied_at, effects_stage, auth_verdict, created_at
        `
        const row = inserted[0]
        if (!row) return null
        const setUnread = input.direction === "in"
        await tx`
          UPDATE mail_threads
          SET last_message_at = GREATEST(COALESCE(last_message_at, ${row.created_at}), ${row.created_at}),
              unread = ${setUnread} OR unread
              ${input.threadStatus !== undefined ? tx`, status = ${input.threadStatus}` : tx``}
          WHERE id = ${input.threadId}
        `
        await writeMailAudit(tx, input.audit)
        return toMessageRecord(row)
      })
    },

    async setMessageMessageId(id: string, rfcMessageId: string): Promise<void> {
      await sql`UPDATE mail_messages SET message_id = ${rfcMessageId} WHERE id = ${id}`
    },

    async listThreads(input: ListThreadsInput): Promise<ListThreadsResult> {
      const limit = clampLimit(input.limit)
      const anchor = decodeCursor(input.cursor, true)
      const activityAt = sql`COALESCE(t.last_message_at, t.created_at)`
      const cursorFilter =
        anchor !== null ? sql`AND ${keysetPredicate(sql, activityAt, sql`t.id`, anchor)}` : sql``
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
      const rows = await sql<(ThreadListRowSelect & { cursor_at: string })[]>`
        SELECT ${threadColumns(sql, "t")},
               lm.direction AS lm_direction, lm.from_addr AS lm_from_addr, lm.to_addr AS lm_to_addr,
               lm.body AS lm_body, ${keysetInstant(sql, activityAt)} AS cursor_at
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
      const { items: page, nextCursor } = paginateKeyset(rows, limit, (r) => ({
        atText: r.cursor_at,
        id: r.id,
      }))
      const items = page.map((r) => {
        const thread = toThreadRecord(r)
        return toThreadListItem(thread, latestPreviewMessage(r, thread))
      })
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
        SELECT id, thread_id, direction, from_addr, to_addr, subject,
               left(body, ${MAIL_BODY_DETAIL_CHARS}) AS body,
               length(body) > ${MAIL_BODY_DETAIL_CHARS} AS truncated,
               kind, attachments, message_id, in_reply_to, unaffiliated, effects_claimed_at,
                    effects_applied_at, effects_stage, auth_verdict, created_at, delivery
        FROM (
          SELECT m.id, m.thread_id, m.direction, m.from_addr, m.to_addr, m.subject, m.body, m.kind,
                 m.attachments, m.message_id, m.in_reply_to, m.unaffiliated, m.effects_claimed_at,
                 m.effects_applied_at, m.effects_stage, m.auth_verdict, m.created_at,
                 d.type AS delivery
          FROM mail_messages m
          LEFT JOIN (
            SELECT DISTINCT ON (e.message_id) e.message_id, e.type
            FROM mail_events e
            WHERE e.thread_id = ${id}
              AND e.type IN ('sent', 'failed')
            ORDER BY e.message_id, e.created_at DESC, e.id DESC
          ) d ON d.message_id = m.id::text
          WHERE m.thread_id = ${id}
          ORDER BY m.created_at DESC, m.id DESC
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

    async findMessageByMessageId(messageId: string): Promise<MailMessageRecord | null> {
      const rows = await sql<MessageRowSelect[]>`
        SELECT ${messageColumns(sql)}
        FROM mail_messages
        WHERE message_id = ${messageId}
        LIMIT 1
      `
      return rows[0] ? toMessageRecord(rows[0]) : null
    },

    async findInboundMessage(
      threadId: string,
      messageId: string,
    ): Promise<MailMessageRecord | null> {
      const rows = await sql<MessageRowSelect[]>`
        SELECT ${messageColumns(sql)}
        FROM mail_messages
        WHERE id = ${messageId} AND thread_id = ${threadId} AND direction = 'in'
        LIMIT 1
      `
      return rows[0] ? toMessageRecord(rows[0]) : null
    },

    async approveWithheldReply(
      messageId: string,
      audit: MailAuditInput,
    ): Promise<MailMessageRecord | null> {
      return sql.begin(async (tx) => {
        const rows = await tx<MessageRowSelect[]>`
          UPDATE mail_messages
          SET unaffiliated = false
          WHERE id = ${messageId}
            AND direction = 'in'
            AND unaffiliated = true
            AND effects_applied_at IS NULL
          RETURNING ${messageColumns(tx)}
        `
        const row = rows[0]
        if (!row) return null
        await writeAudit(tx, {
          actorId: audit.actorId,
          action: audit.action,
          target: audit.target,
          meta: audit.meta ?? null,
        })
        return toMessageRecord(row)
      })
    },

    async hasSendInFlight(threadId: string): Promise<boolean> {
      const rows = await sql<{ ok: boolean }[]>`
        SELECT ${sendInFlightExpr(sql, sql`${threadId}::uuid`)} AS ok
      `
      return rows[0]?.ok ?? false
    },

    async bounceEventState(input: BounceEventKey): Promise<BounceEventState> {
      const rows = await sql<{ recorded: boolean; complete: boolean }[]>`
        SELECT
          COUNT(*) > 0 AS recorded,
          COALESCE(bool_or((meta->>${BOUNCE_DISCOVERY_PENDING_META_KEY}::text) IS NULL), false) AS complete
        FROM mail_events
        WHERE ${bounceEventMatch(sql, input)}
      `
      const row = rows[0]
      if (row?.recorded !== true) return "none"
      return row.complete ? "complete" : "discovery_pending"
    },

    async markBounceDiscoveryEnqueued(input: BounceEventKey): Promise<void> {
      await sql`
        UPDATE mail_events SET meta = meta - ${BOUNCE_DISCOVERY_PENDING_META_KEY}::text
        WHERE ${bounceEventMatch(sql, input)}
          AND (meta->>${BOUNCE_DISCOVERY_PENDING_META_KEY}::text) IS NOT NULL
      `
    },

    async claimMessageEffects(id: string, input: ClaimEffectsInput): Promise<number | null> {
      const rows = await sql<{ effects_stage: number }[]>`
        UPDATE mail_messages
        SET effects_claimed_at = now()
        WHERE id = ${id}
          AND effects_applied_at IS NULL
          AND (effects_claimed_at IS NULL OR effects_claimed_at < ${input.leaseBefore})
        RETURNING effects_stage
      `
      return rows[0] ? rows[0].effects_stage : null
    },

    async setMessageEffectsStage(id: string, stage: number): Promise<void> {
      await sql`
        UPDATE mail_messages
        SET effects_stage = GREATEST(effects_stage, ${stage})
        WHERE id = ${id}
      `
    },

    async markMessageEffectsApplied(id: string, publishedBy?: MailAuditInput): Promise<void> {
      await sql.begin(async (tx) => {
        const applied = await tx<{ id: string }[]>`
          UPDATE mail_messages
          SET effects_applied_at = now()
          WHERE id = ${id} AND effects_applied_at IS NULL
          RETURNING id
        `
        if (applied.length === 0 || publishedBy === undefined) return
        const audited = await tx<{ id: string }[]>`
          SELECT id FROM audit_log
          WHERE action = ${publishedBy.action}
            AND target = ${publishedBy.target}
            AND meta->>'messageId' = ${id}
          LIMIT 1
        `
        if (audited.length > 0) return
        await writeAudit(tx, {
          actorId: publishedBy.actorId,
          action: publishedBy.action,
          target: publishedBy.target,
          meta: publishedBy.meta ?? null,
        })
      })
    },

    async releaseMessageEffects(id: string): Promise<void> {
      await sql`
        UPDATE mail_messages
        SET effects_claimed_at = NULL
        WHERE id = ${id} AND effects_applied_at IS NULL
      `
    },

    async settleRepliedThread(input: SettleRepliedThreadInput): Promise<void> {
      await sql.begin(async (tx) => {
        const advanced = await tx<{ id: string }[]>`
          UPDATE mail_messages
          SET effects_stage = ${input.stage}
          WHERE id = ${input.messageId} AND effects_stage < ${input.stage}
          RETURNING id
        `
        if (advanced.length === 0) return
        await settleThreadStatusIn(tx, input)
      })
    },

    async settleThreadStatus(input: SettleThreadStatusInput): Promise<void> {
      await sql.begin((tx) => settleThreadStatusIn(tx, input))
    },

    async findMessagesPendingEffects(input: PendingEffectsQuery): Promise<PendingEffects[]> {
      const rows = await sql<PendingEffectsRowSelect[]>`
        SELECT m.id, m.thread_id, m.direction, m.from_addr, m.to_addr, m.subject,
               left(m.body, ${MAIL_BODY_DETAIL_CHARS}) AS body,
               m.kind, m.attachments, m.message_id, m.in_reply_to, m.unaffiliated, m.effects_claimed_at,
               m.effects_applied_at, m.effects_stage, m.auth_verdict,
               m.created_at,
               t.id AS t_id, t.thread_token AS t_thread_token,
               t.jurisdiction_geoid AS t_jurisdiction_geoid, t.report_id AS t_report_id,
               t.cleanup_id AS t_cleanup_id, t.org AS t_org, t.subject AS t_subject,
               t.status AS t_status, t.unread AS t_unread, t.last_message_at AS t_last_message_at,
               t.created_at AS t_created_at
        FROM mail_messages m
        JOIN mail_threads t ON t.id = m.thread_id
        WHERE m.direction = 'in'
          AND m.unaffiliated = false
          AND m.effects_applied_at IS NULL
          AND (m.effects_claimed_at IS NULL OR m.effects_claimed_at < ${input.leaseBefore})
          AND m.created_at < ${input.before}
          AND (t.report_id IS NOT NULL OR t.cleanup_id IS NOT NULL)
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ${input.limit}
      `
      return rows.map((r) => ({
        message: toMessageRecord(r),
        thread: toThreadRecord({
          id: r.t_id,
          thread_token: r.t_thread_token,
          jurisdiction_geoid: r.t_jurisdiction_geoid,
          report_id: r.t_report_id,
          cleanup_id: r.t_cleanup_id,
          org: r.t_org,
          subject: r.t_subject,
          status: r.t_status,
          unread: r.t_unread,
          last_message_at: r.t_last_message_at,
          created_at: r.t_created_at,
        }),
      }))
    },

    async hasWithheldReply(threadId: string): Promise<boolean> {
      const rows = await sql<{ ok: boolean }[]>`SELECT ${withheldReplyExpr(sql, threadId)} AS ok`
      return rows[0]?.ok ?? false
    },

    async markThreadRead(id: string): Promise<boolean> {
      const rows = await sql<{ id: string }[]>`
        UPDATE mail_threads SET unread = false WHERE id = ${id} RETURNING id
      `
      return rows.length > 0
    },

    async setThreadStatus(
      id: string,
      status: MailStatus,
      audit?: MailAuditInput,
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const rows = await tx<{ id: string }[]>`
          UPDATE mail_threads SET status = ${status} WHERE id = ${id} RETURNING id
        `
        if (rows.length === 0) return false
        await writeMailAudit(tx, audit)
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

    async recordSendFailure(input: RecordSendFailureInput): Promise<void> {
      const meta = sql.json(input.meta as Parameters<typeof sql.json>[0])
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO mail_events (thread_id, message_id, type, meta)
          VALUES (${input.threadId}, ${input.messageId}, 'failed', ${meta})
        `
        await tx`UPDATE mail_threads SET status = 'needs_action' WHERE id = ${input.threadId}`
        await writeMailAudit(tx, input.audit)
      })
    },

    async setThreadSubject(id: string, subject: string): Promise<void> {
      await sql`UPDATE mail_threads SET subject = ${subject} WHERE id = ${id}`
    },

    async latestOutboundMessageId(threadId: string): Promise<string | null> {
      const rows = await sql<{ id: string }[]>`
        SELECT id
        FROM mail_messages
        WHERE thread_id = ${threadId} AND direction = 'out'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
      return rows[0]?.id ?? null
    },

    async getOutboundMessageForResend(messageId: string): Promise<OutboundMessageSnapshot | null> {
      const rows = await sql<
        {
          id: string
          to_addr: string | null
          subject: string | null
          body: string | null
          html: string | null
        }[]
      >`
        SELECT id, to_addr, subject, body, html
        FROM mail_messages
        WHERE id = ${messageId} AND direction = 'out'
        LIMIT 1
      `
      const row = rows[0]
      if (!row) return null
      return {
        id: row.id,
        toAddr: row.to_addr,
        subject: row.subject,
        body: row.body ?? "",
        html: row.html,
      }
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
        if (row.type in counts) counts[row.type as keyof typeof counts] = parseCount(row.n)
      }
      const mailbox = await sql<{ unread: string; threads: string }[]>`
        SELECT
          COUNT(*) FILTER (WHERE unread = true)::text AS unread,
          COUNT(*)::text AS threads
        FROM mail_threads
      `
      return buildMailStats({
        unread: parseCount(mailbox[0]?.unread),
        threads: parseCount(mailbox[0]?.threads),
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
