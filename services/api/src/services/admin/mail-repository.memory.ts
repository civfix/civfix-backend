
import { randomUUID } from "node:crypto"
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
import {
  deriveWho,
  mintThreadToken,
  toMessageDTO,
  toThreadListItem,
} from "./mail-mappers.js"
import { buildMailStats } from "./mail-stats.js"
import { clampLimit, decodeCursor, encodeCursor } from "./pagination.js"
import type { MailStatsResponse, MailStatus, MailThreadDTO } from "@civfix/shared"

export interface StoredMailEvent {
  id: string
  threadId: string | null
  messageId: string | null
  type: MailEventType
  meta: Record<string, unknown> | null
  createdAt: Date
}

export interface RecordedMailAudit {
  actorId: string | null
  action: string
  target: string
  meta: Record<string, unknown> | null
}

export class InMemoryMailRepository implements MailRepository {
  readonly threads = new Map<string, MailThreadRecord>()
  readonly messages: MailMessageRecord[] = []
  readonly events: StoredMailEvent[] = []
  readonly audits: RecordedMailAudit[] = []
  readonly outreach: Map<string, OutreachStateRecord>

  now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))
  private tick = 0

  constructor(sharedOutreach?: Map<string, OutreachStateRecord>) {
    this.outreach = sharedOutreach ?? new Map<string, OutreachStateRecord>()
  }

  private nextDate(): Date {
    this.tick += 1
    return new Date(this.now.getTime() + this.tick)
  }

  seedThread(over: Partial<MailThreadRecord> = {}): MailThreadRecord {
    const createdAt = over.createdAt ?? this.nextDate()
    const record: MailThreadRecord = {
      id: over.id ?? randomUUID(),
      threadToken: over.threadToken ?? mintThreadToken(),
      jurisdictionGeoid: over.jurisdictionGeoid ?? null,
      reportId: over.reportId ?? null,
      cleanupId: over.cleanupId ?? null,
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

  messagesOf(threadId: string): MailMessageRecord[] {
    return this.messages.filter((m) => m.threadId === threadId).sort((a, b) => cmpCreated(a, b))
  }

  upsertThreadByToken(token: string, init: ThreadInit = {}): Promise<MailThreadRecord> {
    for (const t of this.threads.values()) {
      if (t.threadToken === token) return Promise.resolve({ ...t })
    }
    const record = this.seedThread({
      threadToken: token,
      jurisdictionGeoid: init.jurisdictionGeoid ?? null,
      reportId: init.reportId ?? null,
      cleanupId: init.cleanupId ?? null,
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
      reportId: input.reportId ?? null,
      cleanupId: input.cleanupId ?? null,
      org: input.org ?? null,
      subject: input.subject ?? null,
      status: input.status ?? "sent",
      unread: input.unread ?? false,
    })
    return Promise.resolve({ ...record })
  }

  findOrCreateReportThread(reportId: string, init: ThreadInit = {}): Promise<MailThreadRecord> {
    let best: MailThreadRecord | null = null
    for (const t of this.threads.values()) {
      if (t.reportId !== reportId) continue
      if (best === null || cmpThreadNewest(t, best) > 0) best = t
    }
    if (best) return Promise.resolve({ ...best })
    return this.createThread({ ...init, reportId, threadToken: mintThreadToken() })
  }

  findOrCreateEventThread(cleanupId: string, init: ThreadInit = {}): Promise<MailThreadRecord> {
    let best: MailThreadRecord | null = null
    for (const t of this.threads.values()) {
      if (t.cleanupId !== cleanupId) continue
      if (best === null || cmpThreadNewest(t, best) > 0) best = t
    }
    if (best) return Promise.resolve({ ...best })
    return this.createThread({ ...init, cleanupId, threadToken: mintThreadToken() })
  }

  priorOutboundMessageIds(threadId: string): Promise<string[]> {
    const ids = this.messages
      .filter((m) => m.threadId === threadId && m.direction === "out" && m.messageId !== null)
      .sort((a, b) => cmpCreated(a, b))
      .map((m) => m.messageId as string)
    return Promise.resolve(ids)
  }

  upsertThreadByGeoid(geoid: string, init: ThreadInit = {}): Promise<MailThreadRecord> {
    let best: MailThreadRecord | null = null
    for (const t of this.threads.values()) {
      if (t.jurisdictionGeoid !== geoid || t.reportId !== null) continue
      if (best === null || cmpThreadNewest(t, best) > 0) best = t
    }
    if (best) return Promise.resolve({ ...best })
    return this.createThread({ ...init, jurisdictionGeoid: geoid, threadToken: mintThreadToken() })
  }

  findThreadByToken(token: string): Promise<MailThreadRecord | null> {
    for (const t of this.threads.values()) {
      if (t.threadToken === token) return Promise.resolve({ ...t })
    }
    return Promise.resolve(null)
  }

  findThreadByOutboundMessageIds(messageIds: string[]): Promise<MailThreadRecord | null> {
    const ids = new Set(messageIds.filter((m) => typeof m === "string" && m.length > 0))
    if (ids.size === 0) return Promise.resolve(null)
    let best: MailThreadRecord | null = null
    for (const m of this.messages) {
      if (m.direction !== "out" || m.messageId === null || !ids.has(m.messageId)) continue
      const t = this.threads.get(m.threadId)
      if (!t) continue
      if (best === null || cmpThreadNewest(t, best) > 0) best = t
    }
    return Promise.resolve(best ? { ...best } : null)
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
    const thread = this.threads.get(input.threadId)
    if (thread) {
      const prev = thread.lastMessageAt
      thread.lastMessageAt =
        prev === null || createdAt.getTime() > prev.getTime() ? createdAt : prev
      if (input.direction === "in") thread.unread = true
    }
    this.recordAudit(input.audit)
    return Promise.resolve({ ...record })
  }

  setMessageMessageId(id: string, rfcMessageId: string): Promise<void> {
    const message = this.messages.find((m) => m.id === id)
    if (message) message.messageId = rfcMessageId
    return Promise.resolve()
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
    const latestByThread = this.latestByThread()

    const sortKey = (t: MailThreadRecord): number => (t.lastMessageAt ?? t.createdAt).getTime()

    const isBefore = (t: MailThreadRecord): boolean => {
      if (anchor === null) return true
      const k = sortKey(t)
      const a = anchor.createdAt.getTime()
      if (k !== a) return k < a
      return t.id < anchor.id
    }

    const rows = [...this.threads.values()].filter((t) => {
      const latest = latestByThread.get(t.id) ?? null
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
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    })

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const items = page.map((t) => toThreadListItem(t, latestByThread.get(t.id) ?? null))
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

  messageExists(messageId: string): Promise<boolean> {
    return Promise.resolve(this.messages.some((m) => m.messageId === messageId))
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
    this.recordAudit(audit)
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
    const counts = { sent: 0, bounced: 0, failed: 0 }
    for (const e of this.events) {
      if (e.createdAt.getTime() < cutoff) continue
      if (e.type in counts) counts[e.type as keyof typeof counts] += 1
    }
    let unread = 0
    for (const t of this.threads.values()) if (t.unread) unread += 1
    return Promise.resolve(buildMailStats({ unread, threads: this.threads.size, counts }))
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

  private latestByThread(): Map<string, MailMessageRecord> {
    const latest = new Map<string, MailMessageRecord>()
    for (const m of this.messages) {
      const cur = latest.get(m.threadId)
      if (cur === undefined || cmpCreated(m, cur) > 0) latest.set(m.threadId, m)
    }
    return latest
  }
}

function cmpCreated(a: MailMessageRecord, b: MailMessageRecord): number {
  const d = a.createdAt.getTime() - b.createdAt.getTime()
  if (d !== 0) return d
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function cmpThreadNewest(a: MailThreadRecord, b: MailThreadRecord): number {
  const d = a.createdAt.getTime() - b.createdAt.getTime()
  if (d !== 0) return d
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export { deriveWho }
