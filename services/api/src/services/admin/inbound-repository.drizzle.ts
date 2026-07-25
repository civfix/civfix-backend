/**
 * Postgres-backed InboundRepository (catch-all inbox). The persistence seam for non-reply *@civfix.org
 * mail stored in inbound_emails. Like the mail repository this is written against the RAW postgres-js
 * tag (`Sql`, from `container.getDb().sql`), NOT the Drizzle query builder, so jsonb/Date values use
 * postgres.js's default serializers. The in-memory sibling (inbound-repository.memory.ts) backs tests.
 *
 * insertIdempotent is the dedup core: INSERT ... ON CONFLICT (message_id) DO NOTHING, so a re-delivered
 * email (webhook + sweep racing the same R2 object) lands exactly once. It returns { id, inserted } so
 * the processor can distinguish a fresh insert ("inbox") from a replay.
 *
 * Mapping to @civfix/shared: list -> InboundEmailListItemDTO[]; get -> InboundEmailDTO. `localPart` is
 * derived from `recipient` (split on '@'); attachment keys are the raw R2 keys (the route presigns them).
 * list() selects only what a list ROW needs (bounded body prefixes, no headers/attachments jsonb); the
 * full-row select is get()'s alone.
 */

import type { Sql } from "../../db/client.js"
import { clampLimit, decodeCursor, encodeCursor } from "./pagination.js"
import { likeContains } from "./like.js"
import { writeAudit } from "./audit.js"
import {
  HTML_PREVIEW_SOURCE_CHARS,
  PREVIEW_SOURCE_CHARS,
  toPreview,
} from "./mail-preview.js"
import type {
  InboundEmailDTO,
  InboundEmailListItemDTO,
  InboundEmailStatus,
  InboxListQuery,
  InboxListResponse,
  MailAttachment,
} from "@civfix/shared"

/** Insert input for one inbound email. message_id is already resolved (header or derived) by the caller. */
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

/** Persistence seam for the catch-all inbox. Routes + the inbound processor depend only on this. */
export interface InboundRepository {
  /** Insert idempotently on message_id. `inserted` is false when the row already existed (a replay). */
  insertIdempotent(input: InboundEmailInsert): Promise<{ id: string; inserted: boolean }>
  /** Keyset-paginated inbox list (newest first) mapped to InboundEmailListItemDTO. */
  list(query: InboxListQuery): Promise<InboxListResponse>
  /** A single inbound email mapped to InboundEmailDTO (with raw R2 attachment keys), or null. */
  get(id: string): Promise<InboundEmailDTO | null>
  /**
   * Set an inbound email's triage status. Returns true when the row existed.
   *
   * L6: `actorId` is REQUIRED and the `inbox.status_changed` audit row is written in the SAME transaction
   * as the UPDATE. This mutation used to record neither an actor nor an audit row — the only admin state
   * change in the console that left no trace of who made it.
   */
  setStatus(id: string, status: InboundEmailStatus, actorId: string | null): Promise<boolean>
}

/** The preview policy now lives in mail-preview.ts (one policy for the inbox + the mail lists). */
export { toPreview }

/** The local-part of a catch-all recipient (e.g. "support" from "support@civfix.org"). */
export function localPartOf(recipient: string | null): string {
  if (!recipient) return ""
  const at = recipient.indexOf("@")
  return at > 0 ? recipient.slice(0, at) : recipient
}

/**
 * The columns the LIST projection needs. `preview_*` are bounded prefixes of the bodies, not the bodies:
 * a list page used to drag body_html (up to 512 KB a row), headers and the attachments jsonb across the
 * wire only to throw them away — ~13 MB of discarded payload on a worst-case 25-row page.
 */
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

/** A full row as selected back from SQL for get() (snake_case columns). */
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

/** Construct the production InboundRepository over the raw postgres-js tag. */
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
          ? sql`AND (received_at, id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
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
      const rows = await sql<InboundListRowSelect[]>`
        SELECT id, from_addr, recipient, subject,
               left(body_text, ${PREVIEW_SOURCE_CHARS}) AS preview_text,
               left(body_html, ${HTML_PREVIEW_SOURCE_CHARS}) AS preview_html,
               has_attachments, status, received_at
        FROM inbound_emails
        WHERE true
          ${statusFilter}
          ${recipientFilter}
          ${qFilter}
          ${cursorFilter}
        ORDER BY received_at DESC, id DESC
        LIMIT ${limit + 1}
      `
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const items = page.map(toListItem)
      const last = page[page.length - 1]
      const nextCursor =
        hasMore && last ? encodeCursor({ createdAt: last.received_at, id: last.id }) : null
      return { items, nextCursor }
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
      // L6: effect + audit atomically, matching every other admin mutation in this codebase. The prior
      // status is read in-tx and recorded so the log shows the transition, not just the destination.
      return sql.begin(async (tx) => {
        // Read the prior status FIRST (a plain SELECT; a subquery inside the UPDATE's RETURNING would be
        // reading the same row the statement is writing, which is exactly the kind of subtlety not worth
        // having in an audit path). FOR UPDATE serializes concurrent triage clicks on the same row.
        const existing = await tx<{ status: InboundEmailStatus }[]>`
          SELECT status FROM inbound_emails WHERE id = ${id} LIMIT 1 FOR UPDATE
        `
        const prior = existing[0]?.status
        if (prior === undefined) return false
        await tx`UPDATE inbound_emails SET status = ${status} WHERE id = ${id}`
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
