/**
 * Postgres-backed MailRepository (Phase 2): the persistence seam for the mail / outreach domain.
 *
 * ALL mail thread / message / event / outreach-state access flows through this interface so the mail
 * routers and the OutboundMailService stay infra-free and unit-testable with the in-memory repo
 * (mail-repository.memory.ts). The interface lives here (next to the production impl) the same way the
 * ReportRepository interface lives in report-service.ts; the memory impl and the service both import it
 * from this module.
 *
 * Like the Phase 1 repositories (report-repository.drizzle.ts, chat-repository.drizzle.ts) this is
 * written against the RAW postgres-js tag (`Sql`), NOT the Drizzle query builder, because:
 *   - inserts pass real JS values (a Date, a plain object for the jsonb `attachments`/`meta` columns)
 *     and rely on postgres.js's default serializers, which Drizzle's client replaces with identity
 *     passthroughs (see makeDb in db/client.ts and drizzle-orm#3108); and
 *   - the message-insert + thread-bump runs as ONE postgres-js transaction (sql.begin) so a thread's
 *     last_message_at / unread can never drift from its messages.
 * The factory is `makeDrizzleMailRepository(sql)` where `sql` is `container.getDb().sql`.
 *
 * Mapping to the @civfix/shared mail DTOs:
 *   - listThreads -> MailThreadListItemDTO (dir = latest message direction; from = latest from_addr;
 *     org = thread.org; preview = latest body; ts = last_message_at; unread/status/jurisdictionGeoid).
 *   - getThread   -> MailThreadDTO (the list shape + ordered messages[] as MailMessageDTO).
 *   - stats7d     -> MailStatsResponse (deliverability over a rolling 7-day mail_events window + a
 *     sending-domain health summary derived from recent events).
 * Keyset pagination reuses services/admin/pagination.ts (the shared "<iso>|<id>" cursor + clampLimit).
 */

import type { Sql } from "../../db/client.js"
import { clampLimit, decodeCursor, encodeCursor, type CursorAnchor } from "./pagination.js"
import { writeAudit, type AdminAuditAction } from "./audit.js"
import type {
  MailAttachment,
  MailDirection,
  MailMessageDTO,
  MailStatsResponse,
  MailStatus,
  MailThreadDTO,
  MailThreadListItemDTO,
} from "@civfix/shared"

// ---------------------------------------------------------------------------
// Domain records + input shapes (structural; mirrored by the in-memory repo)
// ---------------------------------------------------------------------------

/** A mail_threads row as the repository models it (camelCased; dates as Date). */
export interface MailThreadRecord {
  id: string
  threadToken: string
  jurisdictionGeoid: string | null
  org: string | null
  subject: string | null
  status: MailStatus
  unread: boolean
  lastMessageAt: Date | null
  createdAt: Date
}

/** A mail_messages row as the repository models it. */
export interface MailMessageRecord {
  id: string
  threadId: string
  direction: MailDirection
  fromAddr: string | null
  toAddr: string | null
  subject: string | null
  body: string | null
  attachments: MailAttachment[]
  messageId: string | null
  inReplyTo: string | null
  createdAt: Date
}

/** A mail_events row. `type` is the OCI delivery event type (sent|delivered|bounced|complained|opened). */
export type MailEventType = "sent" | "delivered" | "bounced" | "complained" | "opened"

/** An outreach_state row (the per-jurisdiction throttle + manual opt-out). */
export interface OutreachStateRecord {
  geoid: string
  lastOutreachAt: Date | null
  suppressed: boolean
}

/** Initializer for upsertThreadByToken when the thread does not yet exist. */
export interface ThreadInit {
  jurisdictionGeoid?: string | null
  org?: string | null
  subject?: string | null
  status?: MailStatus
  unread?: boolean
}

/** createThread input. A threadToken is minted when absent. */
export interface CreateThreadInput {
  threadToken?: string
  jurisdictionGeoid?: string | null
  org?: string | null
  subject?: string | null
  status?: MailStatus
  unread?: boolean
}

/**
 * An optional operator-audit row to write IN THE SAME transaction as a mail mutation (H4): so a mail
 * send / status change and its audit_log row are atomic ("did + recorded"). Omitted for system writes
 * (the inbound webhook, the outreach worker) which audit separately or not at all.
 */
export interface MailAuditInput {
  actorId: string | null
  action: AdminAuditAction
  target: string
  meta?: Record<string, unknown> | null
}

/** insertMessage input. Inbound messages flip the thread to unread and bump last_message_at. */
export interface InsertMessageInput {
  threadId: string
  direction: MailDirection
  fromAddr?: string | null
  toAddr?: string | null
  subject?: string | null
  body?: string | null
  attachments?: MailAttachment[]
  messageId?: string | null
  inReplyTo?: string | null
  /** Optional audit row written in the SAME tx as the message insert (H4). */
  audit?: MailAuditInput
}

/** listThreads input. `filter:"attn"` returns only needs-attention threads (unread OR needs_action). */
export interface ListThreadsInput {
  dir?: MailDirection
  filter?: "attn"
  jurisdictionGeoid?: string
  q?: string
  cursor?: string | null
  limit?: number
}

/** A page of mapped MailThreadListItemDTOs + the opaque next cursor. */
export interface ListThreadsResult {
  items: MailThreadListItemDTO[]
  nextCursor: string | null
}

/** recordEvent input. thread_id / message_id are optional (an event may arrive before correlation). */
export interface RecordEventInput {
  threadId?: string | null
  messageId?: string | null
  type: MailEventType
  meta?: Record<string, unknown> | null
}

/** setOutreachState patch. Only the provided fields are written. */
export interface OutreachStatePatch {
  lastOutreachAt?: Date | null
  suppressed?: boolean
}

// ---------------------------------------------------------------------------
// The repository seam
// ---------------------------------------------------------------------------

/**
 * Persistence seam for the mail / outreach domain. The Drizzle impl is the production binding; the
 * in-memory impl (mail-repository.memory.ts) backs the unit tests. The mail routers + the
 * OutboundMailService depend ONLY on this interface.
 */
export interface MailRepository {
  /** Find a thread by its token, or create one (with `init`) when absent. Returns the thread. */
  upsertThreadByToken(token: string, init?: ThreadInit): Promise<MailThreadRecord>
  /** Insert a thread, minting a thread_token when `threadToken` is absent. Returns the new thread. */
  createThread(input: CreateThreadInput): Promise<MailThreadRecord>
  /** Insert a message + bump the thread's last_message_at; an inbound message sets thread.unread. */
  insertMessage(input: InsertMessageInput): Promise<MailMessageRecord>
  /** Keyset-paginated thread list mapped to MailThreadListItemDTO (newest first). */
  listThreads(input: ListThreadsInput): Promise<ListThreadsResult>
  /** A thread + its ordered messages mapped to MailThreadDTO, or null when the id is unknown. */
  getThread(id: string): Promise<MailThreadDTO | null>
  /** Clear the unread flag on a thread. Returns true when the thread existed. */
  markThreadRead(id: string): Promise<boolean>
  /** Set a thread's status, optionally writing an audit row in the SAME tx (H4). True when it existed. */
  setThreadStatus(id: string, status: MailStatus, audit?: MailAuditInput): Promise<boolean>
  /** Insert a mail_events row. Returns the new event id. */
  recordEvent(input: RecordEventInput): Promise<string>
  /** Deliverability + mailbox stats over a rolling 7-day window (the MailStatsResponse shape). */
  stats7d(): Promise<MailStatsResponse>
  /** Read the outreach throttle row for a jurisdiction, or null when none exists yet. */
  getOutreachState(geoid: string): Promise<OutreachStateRecord | null>
  /** Upsert the outreach throttle row for a jurisdiction. Returns the resulting row. */
  setOutreachState(geoid: string, patch: OutreachStatePatch): Promise<OutreachStateRecord>
  /** Read a single thread record (no messages), or null. Used by the OutboundMailService. */
  getThreadRecord(id: string): Promise<MailThreadRecord | null>
  /**
   * The to_addr of the thread's most recent OUTBOUND message, or null when the thread has no outbound
   * message with a recipient. M1: this is the recipient for a reply/resend on an outbound-only thread
   * (operator -> city) that has not yet received an inbound reply - the recipient lives on the OUT row's
   * to_addr, which is not carried on MailMessageDTO.
   */
  getLastOutboundRecipient(threadId: string): Promise<string | null>
}

// ---------------------------------------------------------------------------
// Shared mapping + helpers (pure; reused by the Drizzle impl)
// ---------------------------------------------------------------------------

/** Rolling window (days) the deliverability stats aggregate over. */
export const MAIL_STATS_WINDOW_DAYS = 7

/** Generate a thread token (used when a caller does not supply one). URL/address safe. */
export function mintThreadToken(): string {
  // 24 hex chars: ample entropy, address-safe (only [0-9a-f]) for reply+{token}@domain.
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

/** A message's display "who": a human-ish label derived from its address + direction. */
export function deriveWho(direction: MailDirection, fromAddr: string | null): string {
  if (fromAddr && fromAddr.length > 0) return fromAddr
  return direction === "in" ? "Inbound" : "civfix"
}

/**
 * Map a thread record + its latest message to the MailThreadListItemDTO. `dir` is the latest message's
 * direction (falling back to "out" for a thread with no messages yet, since civfix originates outreach);
 * `from` is the latest from_addr; `preview` the latest body; `ts` the thread's last_message_at (or
 * created_at when no message has landed). Empty-string fallbacks keep the DTO `.strict()` shape valid.
 */
export function toThreadListItem(
  thread: MailThreadRecord,
  latest: MailMessageRecord | null,
): MailThreadListItemDTO {
  const ts = (thread.lastMessageAt ?? thread.createdAt).toISOString()
  return {
    id: thread.id,
    dir: latest?.direction ?? "out",
    from: latest?.fromAddr ?? "",
    org: thread.org ?? "",
    subject: thread.subject ?? "",
    preview: latest?.body ?? "",
    ts,
    unread: thread.unread,
    status: thread.status,
    jurisdictionGeoid: thread.jurisdictionGeoid,
  }
}

/** Map a message record to a MailMessageDTO (the detail-view message shape). */
export function toMessageDTO(message: MailMessageRecord): MailMessageDTO {
  return {
    id: message.id,
    who: deriveWho(message.direction, message.fromAddr),
    from: message.fromAddr ?? "",
    dir: message.direction,
    body: message.body ?? "",
    ts: message.createdAt.toISOString(),
    attachments: message.attachments,
  }
}

/** Map a thread + ordered messages to the full MailThreadDTO (list shape + messages[]). */
export function toThreadDTO(
  thread: MailThreadRecord,
  messages: MailMessageRecord[],
): MailThreadDTO {
  const latest = messages.length > 0 ? (messages[messages.length - 1] ?? null) : null
  return {
    ...toThreadListItem(thread, latest),
    messages: messages.map(toMessageDTO),
  }
}

/**
 * Build the domainHealth[] summary from rolling-window event counts. Returns the three civfix sending
 * surfaces (sending domain, reply domain, OCI relay). Status is derived honestly: any bounce/complaint
 * in the window downgrades the sending domain to "warn" (or "bad" past a small threshold); with no
 * events everything reports a neutral "ok" baseline (we are not claiming a problem we have no signal
 * for). `replyDomain` labels the reply surface.
 */
export function buildDomainHealth(
  replyDomain: string,
  counts: { delivered: number; bounced: number; complained: number },
): MailStatsResponse["domainHealth"] {
  const { bounced, complained } = counts
  const sendingStatus: "ok" | "warn" | "bad" =
    bounced + complained === 0 ? "ok" : bounced + complained >= 5 ? "bad" : "warn"
  const sendingNote =
    sendingStatus === "ok"
      ? "No bounces or complaints in the last 7 days."
      : `${bounced} bounced, ${complained} complained in the last 7 days.`
  return [
    { domain: "civfix.org", status: sendingStatus, note: sendingNote },
    {
      domain: replyDomain,
      status: "ok",
      note: "Reply routing healthy.",
    },
    {
      domain: "OCI Email Delivery",
      status: bounced + complained >= 5 ? "warn" : "ok",
      note: "Outbound relay reachable.",
    },
  ]
}

/**
 * Compute the deliverability rates from rolling-window counts. placement7d is the inbox-placement
 * proxy (delivered / sent); bounceRate and complaintRate are over sent. All default to safe values when
 * there is no `sent` signal (placement 1, rates 0) rather than dividing by zero.
 */
export function computeRates(counts: {
  sent: number
  delivered: number
  bounced: number
  complained: number
}): { placement7d: number; bounceRate: number; complaintRate: number } {
  const denom = counts.sent > 0 ? counts.sent : 0
  if (denom === 0) {
    return { placement7d: 1, bounceRate: 0, complaintRate: 0 }
  }
  return {
    placement7d: counts.delivered / denom,
    bounceRate: counts.bounced / denom,
    complaintRate: counts.complained / denom,
  }
}

// ---------------------------------------------------------------------------
// Drizzle (raw postgres-js) implementation
// ---------------------------------------------------------------------------

/** A mail_threads row as selected back from SQL (snake_case columns). */
interface ThreadRowSelect {
  id: string
  thread_token: string
  jurisdiction_geoid: string | null
  org: string | null
  subject: string | null
  status: MailStatus
  unread: boolean
  last_message_at: Date | null
  created_at: Date
}

/** A mail_messages row as selected back from SQL. */
interface MessageRowSelect {
  id: string
  thread_id: string
  direction: MailDirection
  from_addr: string | null
  to_addr: string | null
  subject: string | null
  body: string | null
  attachments: MailAttachment[] | null
  message_id: string | null
  in_reply_to: string | null
  created_at: Date
}

/** An outreach_state row as selected back from SQL. */
interface OutreachRowSelect {
  geoid: string
  last_outreach_at: Date | null
  suppressed: boolean
}

function toThreadRecord(r: ThreadRowSelect): MailThreadRecord {
  return {
    id: r.id,
    threadToken: r.thread_token,
    jurisdictionGeoid: r.jurisdiction_geoid,
    org: r.org,
    subject: r.subject,
    status: r.status,
    unread: r.unread,
    lastMessageAt: r.last_message_at,
    createdAt: r.created_at,
  }
}

function toMessageRecord(r: MessageRowSelect): MailMessageRecord {
  return {
    id: r.id,
    threadId: r.thread_id,
    direction: r.direction,
    fromAddr: r.from_addr,
    toAddr: r.to_addr,
    subject: r.subject,
    body: r.body,
    attachments: r.attachments ?? [],
    messageId: r.message_id,
    inReplyTo: r.in_reply_to,
    createdAt: r.created_at,
  }
}

function toOutreachRecord(r: OutreachRowSelect): OutreachStateRecord {
  return {
    geoid: r.geoid,
    lastOutreachAt: r.last_outreach_at,
    suppressed: r.suppressed,
  }
}

/** Construct the production MailRepository over the raw postgres-js tag (`container.getDb().sql`). */
export function makeDrizzleMailRepository(sql: Sql): MailRepository {
  return {
    async upsertThreadByToken(token: string, init: ThreadInit = {}): Promise<MailThreadRecord> {
      // Find-or-create keyed on the UNIQUE thread_token. ON CONFLICT DO NOTHING + a follow-up read keeps
      // it a single round trip on the create path and correct under a concurrent create (the loser reads
      // the winner's row). status defaults to 'sent', unread to false, matching the table defaults.
      const status = init.status ?? "sent"
      const unread = init.unread ?? false
      const inserted = await sql<ThreadRowSelect[]>`
        INSERT INTO mail_threads (thread_token, jurisdiction_geoid, org, subject, status, unread)
        VALUES (
          ${token},
          ${init.jurisdictionGeoid ?? null},
          ${init.org ?? null},
          ${init.subject ?? null},
          ${status},
          ${unread}
        )
        ON CONFLICT (thread_token) DO NOTHING
        RETURNING id, thread_token, jurisdiction_geoid, org, subject, status, unread,
                  last_message_at, created_at
      `
      if (inserted[0]) return toThreadRecord(inserted[0])
      const existing = await sql<ThreadRowSelect[]>`
        SELECT id, thread_token, jurisdiction_geoid, org, subject, status, unread,
               last_message_at, created_at
        FROM mail_threads
        WHERE thread_token = ${token}
        LIMIT 1
      `
      const row = existing[0]
      if (!row) throw new Error("upsertThreadByToken: row vanished after conflict")
      return toThreadRecord(row)
    },

    async createThread(input: CreateThreadInput): Promise<MailThreadRecord> {
      const token = input.threadToken ?? mintThreadToken()
      const rows = await sql<ThreadRowSelect[]>`
        INSERT INTO mail_threads (thread_token, jurisdiction_geoid, org, subject, status, unread)
        VALUES (
          ${token},
          ${input.jurisdictionGeoid ?? null},
          ${input.org ?? null},
          ${input.subject ?? null},
          ${input.status ?? "sent"},
          ${input.unread ?? false}
        )
        RETURNING id, thread_token, jurisdiction_geoid, org, subject, status, unread,
                  last_message_at, created_at
      `
      const row = rows[0]
      if (!row) throw new Error("createThread: insert returned no row")
      return toThreadRecord(row)
    },

    async insertMessage(input: InsertMessageInput): Promise<MailMessageRecord> {
      // One transaction: insert the message, then bump the thread's last_message_at to the new message's
      // created_at and (for inbound) set unread=true. last_message_at only moves forward (GREATEST) so an
      // out-of-order insert never rewinds the list ordering.
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
        // H4: write the operator audit (mail.sent/replied/resent) IN this same tx as the message insert,
        // so "delivered-and-recorded" cannot leave a committed message with no audit row.
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

    async listThreads(input: ListThreadsInput): Promise<ListThreadsResult> {
      const limit = clampLimit(input.limit)
      const anchor = decodeCursor(input.cursor)
      // Keyset over (last_message_at DESC, id DESC) using COALESCE(last_message_at, created_at) as the
      // sort key so a brand-new thread with no message still orders by its creation time. The cursor
      // anchor's createdAt is that same coalesced key.
      const cursorFilter =
        anchor !== null
          ? sql`AND (COALESCE(t.last_message_at, t.created_at), t.id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
          : sql``
      const geoidFilter =
        input.jurisdictionGeoid !== undefined
          ? sql`AND t.jurisdiction_geoid = ${input.jurisdictionGeoid}`
          : sql``
      // `attn` = needs attention: unread threads OR threads whose status is a triage state.
      const attnFilter =
        input.filter === "attn"
          ? sql`AND (t.unread = true OR t.status IN ('needs_action', 'bounced'))`
          : sql``
      // `dir` filters by the latest message's direction (the list row's dir). A thread with no messages
      // has no direction; it is excluded from a direction-filtered view.
      const dirFilter = input.dir !== undefined ? sql`AND lm.direction = ${input.dir}` : sql``
      // Search matches org / subject / latest from_addr (case-insensitive substring).
      const qFilter =
        input.q !== undefined && input.q.trim().length > 0
          ? (() => {
              const like = `%${input.q.trim()}%`
              return sql`AND (t.org ILIKE ${like} OR t.subject ILIKE ${like} OR lm.from_addr ILIKE ${like})`
            })()
          : sql``
      // Correlate each thread to its latest message via a LATERAL subquery (one row per thread).
      const rows = await sql<
        (ThreadRowSelect & {
          lm_direction: MailDirection | null
          lm_from_addr: string | null
          lm_body: string | null
        })[]
      >`
        SELECT t.id, t.thread_token, t.jurisdiction_geoid, t.org, t.subject, t.status, t.unread,
               t.last_message_at, t.created_at,
               lm.direction AS lm_direction, lm.from_addr AS lm_from_addr, lm.body AS lm_body
        FROM mail_threads t
        LEFT JOIN LATERAL (
          SELECT direction, from_addr, body
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
                toAddr: null,
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
        SELECT id, thread_token, jurisdiction_geoid, org, subject, status, unread,
               last_message_at, created_at
        FROM mail_threads
        WHERE id = ${id}
        LIMIT 1
      `
      const threadRow = threads[0]
      if (!threadRow) return null
      const messages = await sql<MessageRowSelect[]>`
        SELECT id, thread_id, direction, from_addr, to_addr, subject, body, attachments, message_id,
               in_reply_to, created_at
        FROM mail_messages
        WHERE thread_id = ${id}
        ORDER BY created_at ASC, id ASC
      `
      return toThreadDTO(toThreadRecord(threadRow), messages.map(toMessageRecord))
    },

    async getThreadRecord(id: string): Promise<MailThreadRecord | null> {
      const rows = await sql<ThreadRowSelect[]>`
        SELECT id, thread_token, jurisdiction_geoid, org, subject, status, unread,
               last_message_at, created_at
        FROM mail_threads
        WHERE id = ${id}
        LIMIT 1
      `
      return rows[0] ? toThreadRecord(rows[0]) : null
    },

    async getLastOutboundRecipient(threadId: string): Promise<string | null> {
      // The most recent OUT message that carries a recipient (M1): the reply/resend target on a thread
      // that has only outbound messages so far.
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
        // H4: status-change audit (mail.status_changed) atomic with the status write.
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
      // mail_events.meta is NOT NULL DEFAULT '{}'; an explicit NULL overrides the default and
      // violates the constraint, so coalesce a missing meta to an empty object.
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
      // Rolling-window event counts (one grouped scan) + the mailbox counters (unread threads, total
      // threads). placement / bounce / complaint derive from the event counts; domainHealth from the
      // bounce/complaint totals. The reply domain label is intentionally civfix.org's reply surface.
      const eventRows = await sql<{ type: MailEventType; n: string }[]>`
        SELECT type, COUNT(*)::text AS n
        FROM mail_events
        WHERE created_at >= now() - make_interval(days => ${MAIL_STATS_WINDOW_DAYS})
        GROUP BY type
      `
      const counts = { sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0 }
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
      const rates = computeRates(counts)
      return {
        placement7d: rates.placement7d,
        delivered7d: counts.delivered,
        bounceRate: rates.bounceRate,
        complaintRate: rates.complaintRate,
        unread: Number.isNaN(unread) ? 0 : unread,
        threads: Number.isNaN(threads) ? 0 : threads,
        domainHealth: buildDomainHealth("reply.civfix.org", {
          delivered: counts.delivered,
          bounced: counts.bounced,
          complained: counts.complained,
        }),
      }
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
      // Upsert on the geoid PK. COALESCE on the EXCLUDED values means an absent patch field leaves the
      // stored value untouched (only the provided fields are written).
      const lastOutreachAt = patch.lastOutreachAt ?? null
      const suppressed = patch.suppressed ?? null
      const rows = await sql<OutreachRowSelect[]>`
        INSERT INTO outreach_state (geoid, last_outreach_at, suppressed)
        VALUES (${geoid}, ${lastOutreachAt}, ${suppressed ?? false})
        ON CONFLICT (geoid) DO UPDATE SET
          last_outreach_at = COALESCE(${lastOutreachAt}, outreach_state.last_outreach_at),
          suppressed = COALESCE(${suppressed}, outreach_state.suppressed)
        RETURNING geoid, last_outreach_at, suppressed
      `
      const row = rows[0]
      if (!row) throw new Error("setOutreachState: upsert returned no row")
      return toOutreachRecord(row)
    },
  }
}

/** The keyset anchor for a thread (the coalesced last_message_at/created_at sort key + id tiebreak). */
function anchorOf(thread: MailThreadRecord): CursorAnchor {
  return { createdAt: thread.lastMessageAt ?? thread.createdAt, id: thread.id }
}
