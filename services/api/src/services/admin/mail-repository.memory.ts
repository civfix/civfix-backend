/**
 * In-memory MailRepository (Phase 2): the offline binding of the mail persistence seam.
 *
 * Mirrors the Drizzle impl's OBSERVABLE contract so the mail routers and the OutboundMailService can be
 * unit-tested with NO database (no Docker), the same way InMemoryReportRepository backs the report
 * service tests:
 *   - upsertThreadByToken is find-or-create on the token;
 *   - insertMessage bumps last_message_at (forward only) and sets unread for an inbound message;
 *   - listThreads pages newest-first over COALESCE(last_message_at, created_at) with the shared
 *     "<iso>|<id>" keyset cursor, and applies the dir / attn / geoid / q filters;
 *   - stats7d aggregates mail_events over a rolling 7-day window from the seeded `now`.
 * The Drizzle-backed repository is covered by the Docker-gated integration test; this fake exercises the
 * same MailRepository seam. Seed/inspect helpers (seedThread, seedMessage, seedEvent, the public maps)
 * let tests arrange + assert state directly.
 */

import { randomUUID } from "node:crypto"
import {
  buildDomainHealth,
  computeRates,
  deriveWho,
  mintThreadToken,
  toMessageDTO,
  toThreadListItem,
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
} from "./mail-repository.drizzle.js"
import { clampLimit, decodeCursor, encodeCursor } from "./pagination.js"
import type { MailDirection, MailStatsResponse, MailStatus, MailThreadDTO } from "@civfix/shared"

/** A stored mail_events row (the subset the stats aggregation reads). */
export interface StoredMailEvent {
  id: string
  threadId: string | null
  messageId: string | null
  type: MailEventType
  meta: Record<string, unknown> | null
  createdAt: Date
}

/** A recorded operator-audit row (the in-tx writeAudit mirror), inspectable by tests (H4). */
export interface RecordedMailAudit {
  actorId: string | null
  action: string
  target: string
  meta: Record<string, unknown> | null
}

/** An in-memory MailRepository faithful to the Drizzle impl's observable behavior. */
export class InMemoryMailRepository implements MailRepository {
  readonly threads = new Map<string, MailThreadRecord>()
  readonly messages: MailMessageRecord[] = []
  readonly events: StoredMailEvent[] = []
  /** Recorded operator-audit rows (the in-tx writeAudit mirror) so mail tests can assert audits (H4). */
  readonly audits: RecordedMailAudit[] = []
  /**
   * The outreach_state store. Defaults to its own map; a test may inject a SHARED map (the one production
   * backs with the single outreach_state table) so another repo - e.g. the contacts repo's enqueue
   * throttle - reads the SAME state this repo's setOutreachState stamps on send.
   */
  readonly outreach: Map<string, OutreachStateRecord>

  /**
   * Deterministic clock for created_at ordering. Tests can override `now` to anchor the stats window;
   * each insert advances by one millisecond so ordering within a test is stable + strictly increasing.
   */
  now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))
  private tick = 0

  /** @param sharedOutreach optional outreach_state store shared with another repo (the production table). */
  constructor(sharedOutreach?: Map<string, OutreachStateRecord>) {
    this.outreach = sharedOutreach ?? new Map<string, OutreachStateRecord>()
  }

  private nextDate(): Date {
    this.tick += 1
    return new Date(this.now.getTime() + this.tick)
  }

  // --- seed / inspect helpers -------------------------------------------------

  /** Seed a thread directly. Returns the stored record (a token is minted when absent). */
  seedThread(over: Partial<MailThreadRecord> = {}): MailThreadRecord {
    const createdAt = over.createdAt ?? this.nextDate()
    const record: MailThreadRecord = {
      id: over.id ?? randomUUID(),
      threadToken: over.threadToken ?? mintThreadToken(),
      jurisdictionGeoid: over.jurisdictionGeoid ?? null,
      org: over.org ?? null,
      subject: over.subject ?? null,
      status: over.status ?? "sent",
      unread: over.unread ?? false,
      lastMessageAt: over.lastMessageAt ?? null,
      createdAt,
    }
    this.threads.set(record.id, record)
    return record
  }

  /** Seed a message directly (does NOT bump the thread; use insertMessage for that behavior). */
  seedMessage(over: Partial<MailMessageRecord> & { threadId: string }): MailMessageRecord {
    const record: MailMessageRecord = {
      id: over.id ?? randomUUID(),
      threadId: over.threadId,
      direction: over.direction ?? "out",
      fromAddr: over.fromAddr ?? null,
      toAddr: over.toAddr ?? null,
      subject: over.subject ?? null,
      body: over.body ?? null,
      attachments: over.attachments ?? [],
      messageId: over.messageId ?? null,
      inReplyTo: over.inReplyTo ?? null,
      createdAt: over.createdAt ?? this.nextDate(),
    }
    this.messages.push(record)
    return record
  }

  /** Seed a mail_events row directly (e.g. to set up stats7d assertions). */
  seedEvent(over: Partial<StoredMailEvent> & { type: MailEventType }): StoredMailEvent {
    const record: StoredMailEvent = {
      id: over.id ?? randomUUID(),
      threadId: over.threadId ?? null,
      messageId: over.messageId ?? null,
      type: over.type,
      meta: over.meta ?? null,
      createdAt: over.createdAt ?? this.nextDate(),
    }
    this.events.push(record)
    return record
  }

  /** Test helper: the messages of a thread, ordered oldest-first (as getThread returns them). */
  messagesOf(threadId: string): MailMessageRecord[] {
    return this.messages.filter((m) => m.threadId === threadId).sort((a, b) => cmpCreated(a, b))
  }

  // --- MailRepository ---------------------------------------------------------

  upsertThreadByToken(token: string, init: ThreadInit = {}): Promise<MailThreadRecord> {
    for (const t of this.threads.values()) {
      if (t.threadToken === token) return Promise.resolve({ ...t })
    }
    const record = this.seedThread({
      threadToken: token,
      jurisdictionGeoid: init.jurisdictionGeoid ?? null,
      org: init.org ?? null,
      subject: init.subject ?? null,
      status: init.status ?? "sent",
      unread: init.unread ?? false,
    })
    return Promise.resolve({ ...record })
  }

  createThread(input: CreateThreadInput): Promise<MailThreadRecord> {
    const record = this.seedThread({
      threadToken: input.threadToken ?? mintThreadToken(),
      jurisdictionGeoid: input.jurisdictionGeoid ?? null,
      org: input.org ?? null,
      subject: input.subject ?? null,
      status: input.status ?? "sent",
      unread: input.unread ?? false,
    })
    return Promise.resolve({ ...record })
  }

  insertMessage(input: InsertMessageInput): Promise<MailMessageRecord> {
    const createdAt = this.nextDate()
    const record: MailMessageRecord = {
      id: randomUUID(),
      threadId: input.threadId,
      direction: input.direction,
      fromAddr: input.fromAddr ?? null,
      toAddr: input.toAddr ?? null,
      subject: input.subject ?? null,
      body: input.body ?? null,
      attachments: input.attachments ?? [],
      messageId: input.messageId ?? null,
      inReplyTo: input.inReplyTo ?? null,
      createdAt,
    }
    this.messages.push(record)
    // Bump the thread: last_message_at moves forward only; inbound flips unread on.
    const thread = this.threads.get(input.threadId)
    if (thread) {
      const prev = thread.lastMessageAt
      thread.lastMessageAt =
        prev === null || createdAt.getTime() > prev.getTime() ? createdAt : prev
      if (input.direction === "in") thread.unread = true
    }
    // H4: mirror the in-tx audit so service/route tests can assert the send was recorded.
    this.recordAudit(input.audit)
    return Promise.resolve({ ...record })
  }

  private recordAudit(audit: MailAuditInput | undefined): void {
    if (!audit) return
    this.audits.push({
      actorId: audit.actorId,
      action: audit.action,
      target: audit.target,
      meta: audit.meta ?? null,
    })
  }

  listThreads(input: ListThreadsInput): Promise<ListThreadsResult> {
    const limit = clampLimit(input.limit)
    const anchor = decodeCursor(input.cursor)
    const q = input.q !== undefined ? input.q.trim().toLowerCase() : ""

    const sortKey = (t: MailThreadRecord): number => (t.lastMessageAt ?? t.createdAt).getTime()

    const isBefore = (t: MailThreadRecord): boolean => {
      if (anchor === null) return true
      const k = sortKey(t)
      const a = anchor.createdAt.getTime()
      if (k !== a) return k < a
      return t.id < anchor.id // tie on the sort key -> id DESC keyset
    }

    const rows = [...this.threads.values()].filter((t) => {
      const latest = this.latestOf(t.id)
      if (
        input.jurisdictionGeoid !== undefined &&
        t.jurisdictionGeoid !== input.jurisdictionGeoid
      ) {
        return false
      }
      if (input.filter === "attn") {
        const attn = t.unread || t.status === "needs_action" || t.status === "bounced"
        if (!attn) return false
      }
      if (input.dir !== undefined) {
        if (latest === null || latest.direction !== input.dir) return false
      }
      if (q.length > 0) {
        const hay = `${t.org ?? ""} ${t.subject ?? ""} ${latest?.fromAddr ?? ""}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return isBefore(t)
    })

    rows.sort((a, b) => {
      const cmp = sortKey(b) - sortKey(a)
      if (cmp !== 0) return cmp
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0 // id DESC tiebreak
    })

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const items = page.map((t) => toThreadListItem(t, this.latestOf(t.id)))
    const last = page[page.length - 1]
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.lastMessageAt ?? last.createdAt, id: last.id })
        : null
    return Promise.resolve({ items, nextCursor })
  }

  getThread(id: string): Promise<MailThreadDTO | null> {
    const thread = this.threads.get(id)
    if (!thread) return Promise.resolve(null)
    const messages = this.messagesOf(id)
    const latest = messages.length > 0 ? (messages[messages.length - 1] ?? null) : null
    const dto: MailThreadDTO = {
      ...toThreadListItem(thread, latest),
      messages: messages.map(toMessageDTO),
    }
    return Promise.resolve(dto)
  }

  getThreadRecord(id: string): Promise<MailThreadRecord | null> {
    const t = this.threads.get(id)
    return Promise.resolve(t ? { ...t } : null)
  }

  getLastOutboundRecipient(threadId: string): Promise<string | null> {
    let best: MailMessageRecord | null = null
    for (const m of this.messages) {
      if (m.threadId !== threadId) continue
      if (m.direction !== "out") continue
      if (m.toAddr === null || m.toAddr === "") continue
      if (best === null || cmpCreated(m, best) > 0) best = m
    }
    return Promise.resolve(best?.toAddr ?? null)
  }

  markThreadRead(id: string): Promise<boolean> {
    const t = this.threads.get(id)
    if (!t) return Promise.resolve(false)
    t.unread = false
    return Promise.resolve(true)
  }

  setThreadStatus(id: string, status: MailStatus, audit?: MailAuditInput): Promise<boolean> {
    const t = this.threads.get(id)
    if (!t) return Promise.resolve(false)
    t.status = status
    this.recordAudit(audit) // H4
    return Promise.resolve(true)
  }

  recordEvent(input: RecordEventInput): Promise<string> {
    const record = this.seedEvent({
      threadId: input.threadId ?? null,
      messageId: input.messageId ?? null,
      type: input.type,
      meta: input.meta ?? null,
    })
    return Promise.resolve(record.id)
  }

  stats7d(): Promise<MailStatsResponse> {
    const cutoff = this.now.getTime() - MAIL_STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000
    const counts = { sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0 }
    for (const e of this.events) {
      if (e.createdAt.getTime() < cutoff) continue
      counts[e.type] += 1
    }
    let unread = 0
    for (const t of this.threads.values()) if (t.unread) unread += 1
    const threads = this.threads.size
    const rates = computeRates(counts)
    const dto: MailStatsResponse = {
      placement7d: rates.placement7d,
      delivered7d: counts.delivered,
      bounceRate: rates.bounceRate,
      complaintRate: rates.complaintRate,
      unread,
      threads,
      domainHealth: buildDomainHealth("reply.civfix.org", {
        delivered: counts.delivered,
        bounced: counts.bounced,
        complained: counts.complained,
      }),
    }
    return Promise.resolve(dto)
  }

  getOutreachState(geoid: string): Promise<OutreachStateRecord | null> {
    const r = this.outreach.get(geoid)
    return Promise.resolve(r ? { ...r } : null)
  }

  setOutreachState(geoid: string, patch: OutreachStatePatch): Promise<OutreachStateRecord> {
    const prev = this.outreach.get(geoid)
    const record: OutreachStateRecord = {
      geoid,
      lastOutreachAt:
        patch.lastOutreachAt !== undefined ? patch.lastOutreachAt : (prev?.lastOutreachAt ?? null),
      suppressed: patch.suppressed !== undefined ? patch.suppressed : (prev?.suppressed ?? false),
    }
    this.outreach.set(geoid, record)
    return Promise.resolve({ ...record })
  }

  /** The latest (newest) message of a thread, or null. */
  private latestOf(threadId: string): MailMessageRecord | null {
    let latest: MailMessageRecord | null = null
    for (const m of this.messages) {
      if (m.threadId !== threadId) continue
      if (latest === null || cmpCreated(m, latest) > 0) latest = m
    }
    return latest
  }
}

/** Compare two messages by (created_at ASC, id ASC). Positive when `a` is newer. */
function cmpCreated(a: MailMessageRecord, b: MailMessageRecord): number {
  const d = a.createdAt.getTime() - b.createdAt.getTime()
  if (d !== 0) return d
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// Re-export `deriveWho` so tests that assert the message "who" projection can import it from the memory
// module alongside the repo (keeps the test import surface to one module).
export { deriveWho }

// Reference the imported MailDirection type so the explicit import is "used" by a type alias that
// documents the inbound/outbound contract for readers of this module.
/** Direction of a stored message: "in" (received) or "out" (sent by civfix). */
export type StoredMailDirection = MailDirection
