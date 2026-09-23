import type { Sql } from "../../db/client.js"
import {
  clampLimit,
  decodeCursor,
  keysetInstant,
  keysetPredicate,
  paginateKeyset,
} from "./pagination.js"
import { likeContains } from "./like.js"
import { writeAudit } from "./audit.js"
import { HTML_PREVIEW_SOURCE_CHARS, PREVIEW_SOURCE_CHARS, toPreview } from "./mail-preview.js"
import type {
  InboundEmailDTO,
  InboundEmailListItemDTO,
  InboundEmailStatus,
  InboxListQuery,
  InboxListResponse,
  MailAttachment,
} from "@civfix/shared"

export interface InboundEmailInsert {
  messageId: string
  fromAddr: string | null
  toAddr: string | null
  recipient: string | null
  subject: string | null
  bodyText: string | null
  bodyHtml: string | null
  headers: Record<string, string>
  attachments: MailAttachment[]
  receivedAt?: Date
}

export interface InboundRepository {
  insertIdempotent(input: InboundEmailInsert): Promise<{ id: string; inserted: boolean }>
  list(query: InboxListQuery): Promise<InboxListResponse>
  get(id: string): Promise<InboundEmailDTO | null>
  setStatus(id: string, status: InboundEmailStatus, actorId: string | null): Promise<boolean>
}

export { toPreview }

export function localPartOf(recipient: string | null): string {
  if (!recipient) return ""
  const at = recipient.indexOf("@")
  return at > 0 ? recipient.slice(0, at) : recipient
}

interface InboundListRowSelect {
  id: string
  from_addr: string | null
  recipient: string | null
  subject: string | null
  preview_text: string | null
  preview_html: string | null
  has_attachments: boolean
  status: InboundEmailStatus
  received_at: Date
}

interface InboundRowSelect extends Omit<InboundListRowSelect, "preview_text" | "preview_html"> {
  message_id: string
  to_addr: string | null
  body_text: string | null
  body_html: string | null
  headers: Record<string, string> | null
  attachments: MailAttachment[] | null
}

function toListItem(r: InboundListRowSelect): InboundEmailListItemDTO {
  return {
    id: r.id,
    from: r.from_addr ?? "",
    recipient: r.recipient ?? "",
    localPart: localPartOf(r.recipient),
    subject: r.subject ?? "",
    preview: toPreview(r.preview_text, r.preview_html),
    ts: r.received_at.toISOString(),
    status: r.status,
    unread: r.status === "unread",
    hasAttachments: r.has_attachments,
  }
}

function toDTO(r: InboundRowSelect): InboundEmailDTO {
  return {
    ...toListItem({ ...r, preview_text: r.body_text, preview_html: r.body_html }),
    bodyText: r.body_text ?? "",
    bodyHtml: r.body_html,
    messageId: r.message_id,
    attachments: r.attachments ?? [],
  }
}

export function makeDrizzleInboundRepository(sql: Sql): InboundRepository {
  return {
    async insertIdempotent(input: InboundEmailInsert): Promise<{ id: string; inserted: boolean }> {
      const receivedAt = input.receivedAt ?? new Date()
      const inserted = await sql<{ id: string }[]>`
        INSERT INTO inbound_emails (
          message_id, from_addr, to_addr, recipient, subject, body_text, body_html,
          headers, attachments, has_attachments, received_at
        ) VALUES (
          ${input.messageId},
          ${input.fromAddr},
          ${input.toAddr},
          ${input.recipient},
          ${input.subject},
          ${input.bodyText},
          ${input.bodyHtml},
          ${sql.json(input.headers as Parameters<typeof sql.json>[0])},
          ${sql.json(input.attachments as Parameters<typeof sql.json>[0])},
          ${input.attachments.length > 0},
          ${receivedAt}
        )
        ON CONFLICT (message_id) DO NOTHING
        RETURNING id
      `
      if (inserted[0]) return { id: inserted[0].id, inserted: true }
      const existing = await sql<{ id: string }[]>`
        SELECT id FROM inbound_emails WHERE message_id = ${input.messageId} LIMIT 1
      `
      const row = existing[0]
      if (!row) throw new Error("insertIdempotent: row vanished after conflict")
      return { id: row.id, inserted: false }
    },

    async list(query: InboxListQuery): Promise<InboxListResponse> {
      const limit = clampLimit(query.limit)
      const anchor = decodeCursor(query.cursor, true)
      const cursorFilter =
        anchor !== null
          ? sql`AND ${keysetPredicate(sql, sql`received_at`, sql`id`, anchor)}`
          : sql``
      const statusFilter =
        query.status === "unread"
          ? sql`AND status = 'unread'`
          : query.status === "archived"
            ? sql`AND status = 'archived'`
            : sql``
      const recipientFilter =
        query.localPart !== undefined && query.localPart.length > 0
          ? sql`AND split_part(recipient, '@', 1) = ${query.localPart}`
          : sql``
      const qFilter =
        query.q !== undefined && query.q.trim().length > 0
          ? (() => {
              const like = likeContains(query.q.trim())
              return sql`AND (from_addr ILIKE ${like} ESCAPE '\\' OR subject ILIKE ${like} ESCAPE '\\' OR recipient ILIKE ${like} ESCAPE '\\')`
            })()
          : sql``
      const rows = await sql<(InboundListRowSelect & { cursor_at: string })[]>`
        SELECT id, from_addr, recipient, subject,
               left(body_text, ${PREVIEW_SOURCE_CHARS}) AS preview_text,
               left(body_html, ${HTML_PREVIEW_SOURCE_CHARS}) AS preview_html,
               has_attachments, status, received_at,
               ${keysetInstant(sql, sql`received_at`)} AS cursor_at
        FROM inbound_emails
        WHERE true
          ${statusFilter}
          ${recipientFilter}
          ${qFilter}
          ${cursorFilter}
        ORDER BY received_at DESC, id DESC
        LIMIT ${limit + 1}
      `
      const { items, nextCursor } = paginateKeyset(rows, limit, (r) => ({
        atText: r.cursor_at,
        id: r.id,
      }))
      return { items: items.map(toListItem), nextCursor }
    },

    async get(id: string): Promise<InboundEmailDTO | null> {
      const rows = await sql<InboundRowSelect[]>`
        SELECT id, message_id, from_addr, to_addr, recipient, subject, body_text, body_html,
               headers, attachments, has_attachments, status, received_at
        FROM inbound_emails
        WHERE id = ${id}
        LIMIT 1
      `
      return rows[0] ? toDTO(rows[0]) : null
    },

    async setStatus(
      id: string,
      status: InboundEmailStatus,
      actorId: string | null,
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const existing = await tx<{ status: InboundEmailStatus }[]>`
          SELECT status FROM inbound_emails WHERE id = ${id} LIMIT 1 FOR UPDATE
        `
        const prior = existing[0]?.status
        if (prior === undefined) return false
        await tx`
          UPDATE inbound_emails
          SET status = ${status},
              archived_at = CASE WHEN ${status === "archived"} THEN COALESCE(archived_at, now()) ELSE NULL END
          WHERE id = ${id}
        `
        await writeAudit(tx, {
          actorId,
          action: "inbox.status_changed",
          target: `inbound_email:${id}`,
          meta: { status, priorStatus: prior },
        })
        return true
      })
    },
  }
}
