import { randomUUID } from "node:crypto"
import {
  MAIL_STATS_WINDOW_DAYS,
  BOUNCE_DISCOVERY_PENDING_META_KEY,
  type BounceEventKey,
  type BounceEventState,
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
  type ClaimEffectsInput,
  type PendingEffects,
  type PendingEffectsQuery,
  type RecordEventInput,
  type RecordSendFailureInput,
  type ThreadInit,
} from "./mail-repository.js"
import { mintThreadToken, toMessageDTO, toThreadListItem } from "./mail-mappers.js"
import { buildMailStats } from "./mail-stats.js"
import {
  ROUTE_CLAIM_STALE_SECONDS,
  ROUTE_DEADLINE_INFLIGHT_SECONDS,
} from "./outbound-send-policy.js"
import { clampLimit, decodeCursor, encodeCursor } from "./pagination.js"
import type { MailDelivery, MailStatsResponse, MailStatus, MailThreadDTO } from "@civfix/shared"

const DAY_MS = 24 * 60 * 60 * 1000

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
      html: over.html ?? null,
      kind: over.kind ?? null,
      attachments: over.attachments ?? [],
      messageId: over.messageId ?? null,
      inReplyTo: over.inReplyTo ?? null,
      unaffiliated: over.unaffiliated ?? false,
      effectsClaimedAt: over.effectsClaimedAt ?? null,
      effectsAppliedAt: over.effectsAppliedAt ?? null,
      effectsStage: over.effectsStage ?? 0,
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

  private newestThread(matches: (t: MailThreadRecord) => boolean): MailThreadRecord | null {
    let best: MailThreadRecord | null = null
    for (const t of this.threads.values()) {
      if (!matches(t)) continue
      if (best === null || cmpCreated(t, best) > 0) best = t
    }
    return best
  }

  private latestMessage(matches: (m: MailMessageRecord) => boolean): MailMessageRecord | null {
    let best: MailMessageRecord | null = null
    for (const m of this.messages) {
      if (!matches(m)) continue
      if (best === null || cmpCreated(m, best) > 0) best = m
    }
    return best
  }

  findOrCreateReportThread(reportId: string, init: ThreadInit = {}): Promise<MailThreadRecord> {
    const best = this.newestThread((t) => t.reportId === reportId)
    if (best) return Promise.resolve({ ...best })
    return this.createThread({ ...init, reportId, threadToken: mintThreadToken() })
  }

  findReportThread(reportId: string): Promise<MailThreadRecord | null> {
    const best = this.newestThread((t) => t.reportId === reportId)
    return Promise.resolve(best === null ? null : { ...best })
  }

  findOrCreateEventThread(cleanupId: string, init: ThreadInit = {}): Promise<MailThreadRecord> {
    const best = this.newestThread((t) => t.cleanupId === cleanupId)
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
    const best = this.newestThread(
      (t) => t.jurisdictionGeoid === geoid && t.reportId === null && t.cleanupId === null,
    )
    if (best) return Promise.resolve({ ...best })
    return this.createThread({
      ...init,
      jurisdictionGeoid: geoid,
      reportId: null,
      cleanupId: null,
      threadToken: mintThreadToken(),
    })
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
      if (best === null || cmpCreated(t, best) > 0) best = t
    }
    return Promise.resolve(best ? { ...best } : null)
  }

  insertMessage(input: InsertMessageInput): Promise<MailMessageRecord | null> {
    if (
      input.messageId !== null &&
      input.messageId !== undefined &&
      this.messages.some((m) => m.messageId === input.messageId)
    ) {
      return Promise.resolve(null)
    }
    const createdAt = this.nextDate()
    const record: MailMessageRecord = {
      id: randomUUID(),
      threadId: input.threadId,
      direction: input.direction,
      fromAddr: input.fromAddr ?? null,
      toAddr: input.toAddr ?? null,
      subject: input.subject ?? null,
      body: input.body ?? null,
      html: input.html ?? null,
      kind: input.kind ?? null,
      attachments: input.attachments ?? [],
      messageId: input.messageId ?? null,
      inReplyTo: input.inReplyTo ?? null,
      unaffiliated: input.unaffiliated ?? false,
      effectsClaimedAt: null,
      effectsAppliedAt: null,
      effectsStage: 0,
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

  deliveryOf(message: MailMessageRecord): MailDelivery | null {
    if (message.direction === "in") return null
    let latest: StoredMailEvent | null = null
    for (const e of this.events) {
      if (e.messageId !== message.id) continue
      if (e.type !== "sent" && e.type !== "failed") continue
      if (latest === null || e.createdAt.getTime() >= latest.createdAt.getTime()) latest = e
    }
    return latest === null ? "pending" : (latest.type as MailDelivery)
  }

  getThread(id: string): Promise<MailThreadDTO | null> {
    const thread = this.threads.get(id)
    if (!thread) return Promise.resolve(null)
    const messages = this.messagesOf(id)
    const latest = messages.length > 0 ? (messages[messages.length - 1] ?? null) : null
    const dto: MailThreadDTO = {
      ...toThreadListItem(thread, latest),
      messages: messages.map((m) => toMessageDTO({ ...m, delivery: this.deliveryOf(m) })),
    }
    return Promise.resolve(dto)
  }

  getThreadRecord(id: string): Promise<MailThreadRecord | null> {
    const t = this.threads.get(id)
    return Promise.resolve(t ? { ...t } : null)
  }

  outboundRecipients(threadId: string): Promise<string[]> {
    const out = new Set<string>()
    for (const m of this.messages) {
      if (m.threadId !== threadId) continue
      if (m.direction !== "out") continue
      if (m.toAddr === null || m.toAddr === "") continue
      out.add(m.toAddr)
    }
    return Promise.resolve([...out])
  }

  getLastOutboundRecipient(threadId: string): Promise<string | null> {
    const best = this.latestMessage(
      (m) =>
        m.threadId === threadId && m.direction === "out" && m.toAddr !== null && m.toAddr !== "",
    )
    return Promise.resolve(best?.toAddr ?? null)
  }

  findMessageByMessageId(messageId: string): Promise<MailMessageRecord | null> {
    const found = this.messages.find((m) => m.messageId === messageId)
    return Promise.resolve(found ? { ...found } : null)
  }

  hasSendInFlight(threadId: string): Promise<boolean> {
    const inflightBefore = this.now.getTime() - ROUTE_DEADLINE_INFLIGHT_SECONDS * 1000
    const staleBefore = this.now.getTime() - ROUTE_CLAIM_STALE_SECONDS * 1000
    const latest = this.latestMessage((m) => m.threadId === threadId && m.direction === "out")
    if (latest === null) return Promise.resolve(false)
    const own = this.events.filter((e) => e.messageId === latest.id)
    if (own.some((e) => e.type === "sent")) return Promise.resolve(false)
    const failed = own.filter((e) => e.type === "failed")
    if (failed.length === 0) return Promise.resolve(latest.createdAt.getTime() > staleBefore)
    return Promise.resolve(
      failed.some(
        (e) =>
          (e.meta as { reason?: unknown } | null)?.reason === "deadline" &&
          e.createdAt.getTime() > inflightBefore,
      ),
    )
  }

  private bounceEvents(input: BounceEventKey): StoredMailEvent[] {
    const recipient = input.failedRecipient.toLowerCase()
    return this.events.filter((e) => {
      if (e.threadId !== input.threadId || e.type !== "bounced") return false
      const meta = e.meta as { originalMessageId?: unknown; failedRecipient?: unknown } | null
      return (
        meta?.originalMessageId === input.originalMessageId &&
        typeof meta.failedRecipient === "string" &&
        meta.failedRecipient.toLowerCase() === recipient
      )
    })
  }

  bounceEventState(input: BounceEventKey): Promise<BounceEventState> {
    const events = this.bounceEvents(input)
    if (events.length === 0) return Promise.resolve("none")
    const complete = events.some((e) => e.meta?.[BOUNCE_DISCOVERY_PENDING_META_KEY] === undefined)
    return Promise.resolve(complete ? "complete" : "discovery_pending")
  }

  markBounceDiscoveryEnqueued(input: BounceEventKey): Promise<void> {
    for (const event of this.bounceEvents(input)) {
      if (event.meta === null) continue
      const { [BOUNCE_DISCOVERY_PENDING_META_KEY]: _pending, ...rest } = event.meta
      event.meta = rest
    }
    return Promise.resolve()
  }

  claimMessageEffects(id: string, input: ClaimEffectsInput): Promise<number | null> {
    const message = this.messages.find((m) => m.id === id)
    if (!message || message.effectsAppliedAt !== null) return Promise.resolve(null)
    if (
      message.effectsClaimedAt !== null &&
      message.effectsClaimedAt.getTime() >= input.leaseBefore.getTime()
    ) {
      return Promise.resolve(null)
    }
    message.effectsClaimedAt = this.nextDate()
    return Promise.resolve(message.effectsStage)
  }

  setMessageEffectsStage(id: string, stage: number): Promise<void> {
    const message = this.messages.find((m) => m.id === id)
    if (message) message.effectsStage = Math.max(message.effectsStage, stage)
    return Promise.resolve()
  }

  markMessageEffectsApplied(id: string): Promise<void> {
    const message = this.messages.find((m) => m.id === id)
    if (message && message.effectsAppliedAt === null) message.effectsAppliedAt = this.nextDate()
    return Promise.resolve()
  }

  releaseMessageEffects(id: string): Promise<void> {
    const message = this.messages.find((m) => m.id === id)
    if (message && message.effectsAppliedAt === null) message.effectsClaimedAt = null
    return Promise.resolve()
  }

  findMessagesPendingEffects(input: PendingEffectsQuery): Promise<PendingEffects[]> {
    const out: PendingEffects[] = []
    for (const m of [...this.messages].sort((a, b) => cmpCreated(a, b))) {
      if (m.direction !== "in" || m.unaffiliated || m.effectsAppliedAt !== null) continue
      if (
        m.effectsClaimedAt !== null &&
        m.effectsClaimedAt.getTime() >= input.leaseBefore.getTime()
      ) {
        continue
      }
      if (m.createdAt.getTime() >= input.before.getTime()) continue
      const thread = this.threads.get(m.threadId)
      if (!thread || (thread.reportId === null && thread.cleanupId === null)) continue
      out.push({ message: { ...m }, thread: { ...thread } })
      if (out.length >= input.limit) break
    }
    return Promise.resolve(out)
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

  async recordSendFailure(input: RecordSendFailureInput): Promise<void> {
    await this.recordEvent({
      threadId: input.threadId,
      messageId: input.messageId,
      type: "failed",
      meta: input.meta,
    })
    const thread = this.threads.get(input.threadId)
    if (thread) thread.status = "needs_action"
    this.recordAudit(input.audit)
  }

  setThreadSubject(id: string, subject: string): Promise<void> {
    const t = this.threads.get(id)
    if (t) t.subject = subject
    return Promise.resolve()
  }

  latestOutboundMessageId(threadId: string): Promise<string | null> {
    const best = this.latestMessage((m) => m.threadId === threadId && m.direction === "out")
    return Promise.resolve(best?.id ?? null)
  }

  getOutboundMessageForResend(messageId: string): Promise<OutboundMessageSnapshot | null> {
    const m = this.messages.find((x) => x.id === messageId && x.direction === "out")
    if (!m) return Promise.resolve(null)
    return Promise.resolve({
      id: m.id,
      toAddr: m.toAddr,
      subject: m.subject,
      body: m.body ?? "",
      html: m.html,
      attachments: m.attachments,
    })
  }

  stats7d(): Promise<MailStatsResponse> {
    const cutoff = this.now.getTime() - MAIL_STATS_WINDOW_DAYS * DAY_MS
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

function cmpCreated(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
): number {
  const d = a.createdAt.getTime() - b.createdAt.getTime()
  if (d !== 0) return d
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
