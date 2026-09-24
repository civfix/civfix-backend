import type { Sql, SqlFragment } from "../../db/client.js"
import { clampLimit } from "./pagination.js"
import {
  keysetInstant,
  keysetPredicate,
  paginateKeyset,
  parseKeysetCursor,
} from "../../db/cursor-helpers.js"
import { HTML_PREVIEW_SOURCE_CHARS, PREVIEW_SOURCE_CHARS, toPreview } from "./mail-preview.js"
import { normalizeAuthVerdict, replyPublication } from "./mail-mappers.js"
import { ilikeAnyOf } from "./sql-fragments.js"
import {
  INBOUND_AUTH_VERDICT_HEADER,
  toListItem,
  type InboundListRowSelect,
} from "./inbound-repository.drizzle.js"
import type {
  InboxFeedFilter,
  InboxFeedItemDTO,
  InboxFeedQuery,
  InboxFeedResponse,
  MailStatus,
} from "@civfix/shared"

export interface InboxFeedRepository {
  list(query: InboxFeedQuery): Promise<InboxFeedResponse>
}

export const INBOX_FEED_EMAIL_FILTERS: ReadonlySet<InboxFeedFilter> = new Set([
  "all",
  "unread",
  "unmatched",
  "archived",
])

export const INBOX_FEED_REPLY_FILTERS: ReadonlySet<InboxFeedFilter> = new Set([
  "all",
  "unread",
  "replies",
  "review",
])

export interface InboxFeedEmailRow extends Omit<InboundListRowSelect, "received_at"> {
  source: "email"
  ts: Date
  cursor_at: string
}

export interface InboxFeedReplyRow {
  source: "reply"
  id: string
  ts: Date
  cursor_at: string
  from_addr: string | null
  subject: string | null
  preview_text: string | null
  has_attachments: boolean
  auth_verdict: string | null
  thread_id: string
  report_id: string | null
  cleanup_id: string | null
  org: string | null
  thread_unread: boolean
  thread_status: MailStatus
  unaffiliated: boolean
  effects_applied_at: Date | null
}

export type InboxFeedRow = InboxFeedEmailRow | InboxFeedReplyRow

function toInboxFeedItem(row: InboxFeedRow): InboxFeedItemDTO {
  if (row.source === "email") {
    return { source: "email", ...toListItem({ ...row, received_at: row.ts }) }
  }
  return {
    source: "reply",
    id: row.id,
    threadId: row.thread_id,
    reportId: row.report_id,
    cleanupId: row.cleanup_id,
    org: row.org ?? "",
    from: row.from_addr ?? "",
    subject: row.subject ?? "",
    preview: toPreview(row.preview_text),
    ts: row.ts.toISOString(),
    unread: row.thread_unread,
    threadStatus: row.thread_status,
    hasAttachments: row.has_attachments,
    authVerdict: normalizeAuthVerdict(row.auth_verdict),
    publication: replyPublication(
      { reportId: row.report_id, cleanupId: row.cleanup_id },
      { direction: "in", unaffiliated: row.unaffiliated, effectsAppliedAt: row.effects_applied_at },
    ),
  }
}

export function toInboxFeedPage(rows: readonly InboxFeedRow[], limit: number): InboxFeedResponse {
  const { items, nextCursor } = paginateKeyset(rows, limit, (r) => ({
    atText: r.cursor_at,
    id: r.id,
  }))
  return { items: items.map(toInboxFeedItem), nextCursor }
}

export function makeDrizzleInboxFeedRepository(sql: Sql): InboxFeedRepository {
  return {
    async list(query: InboxFeedQuery): Promise<InboxFeedResponse> {
      const limit = clampLimit(query.limit)
      const anchor = parseKeysetCursor(query.cursor)
      const filter = query.filter ?? "all"
      const q = query.q?.trim() ?? ""
      const search = (columns: SqlFragment[]): SqlFragment =>
        q === "" ? sql`` : sql`AND ${ilikeAnyOf(sql, columns, q)}`
      const before = (ts: SqlFragment, id: SqlFragment): SqlFragment =>
        anchor === null ? sql`` : sql`AND ${keysetPredicate(sql, ts, id, anchor)}`

      const branches: SqlFragment[] = []
      if (INBOX_FEED_EMAIL_FILTERS.has(filter)) {
        const status =
          filter === "unread" || filter === "archived" ? sql`AND e.status = ${filter}` : sql``
        branches.push(sql`(
          SELECT 'email'::text AS source, e.id, e.received_at AS ts, e.from_addr, e.recipient,
                 e.subject, left(e.body_text, ${PREVIEW_SOURCE_CHARS}) AS preview_text,
                 left(e.body_html, ${HTML_PREVIEW_SOURCE_CHARS}) AS preview_html,
                 e.has_attachments, e.status,
                 e.headers->>${INBOUND_AUTH_VERDICT_HEADER}::text AS auth_verdict,
                 NULL::uuid AS thread_id, NULL::uuid AS report_id, NULL::uuid AS cleanup_id,
                 NULL::text AS org, NULL::boolean AS thread_unread, NULL::text AS thread_status,
                 NULL::boolean AS unaffiliated, NULL::timestamptz AS effects_applied_at
          FROM inbound_emails e
          WHERE true
            ${status}
            ${search([sql`e.from_addr`, sql`e.subject`, sql`e.recipient`])}
            ${before(sql`e.received_at`, sql`e.id`)}
          ORDER BY e.received_at DESC, e.id DESC
          LIMIT ${limit + 1}
        )`)
      }
      if (INBOX_FEED_REPLY_FILTERS.has(filter)) {
        const unread = filter === "unread" ? sql`AND t.unread = true` : sql``
        const review =
          filter === "review"
            ? sql`AND m.unaffiliated = true AND m.effects_applied_at IS NULL
                  AND t.status = 'needs_action'
                  AND (t.report_id IS NOT NULL OR t.cleanup_id IS NOT NULL)`
            : sql``
        branches.push(sql`(
          SELECT 'reply'::text AS source, m.id, m.created_at AS ts, m.from_addr,
                 NULL::text AS recipient, COALESCE(m.subject, t.subject) AS subject,
                 left(m.body, ${PREVIEW_SOURCE_CHARS}) AS preview_text, NULL::text AS preview_html,
                 m.attachments <> '[]'::jsonb AS has_attachments, NULL::text AS status,
                 m.auth_verdict, t.id AS thread_id, t.report_id, t.cleanup_id, t.org,
                 t.unread AS thread_unread, t.status AS thread_status, m.unaffiliated,
                 m.effects_applied_at
          FROM mail_messages m
          JOIN mail_threads t ON t.id = m.thread_id
          WHERE m.direction = 'in'
            ${unread}
            ${review}
            ${search([sql`m.from_addr`, sql`m.subject`, sql`t.subject`, sql`t.org`])}
            ${before(sql`m.created_at`, sql`m.id`)}
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT ${limit + 1}
        )`)
      }

      const union = branches.reduce((acc, branch) => sql`${acc} UNION ALL ${branch}`)
      const rows = await sql<InboxFeedRow[]>`
        SELECT feed.*, ${keysetInstant(sql, sql`feed.ts`)} AS cursor_at
        FROM (${union}) feed
        ORDER BY ts DESC, id DESC
        LIMIT ${limit + 1}
      `
      return toInboxFeedPage(rows, limit)
    },
  }
}
