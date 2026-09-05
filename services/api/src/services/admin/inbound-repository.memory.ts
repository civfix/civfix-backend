
import { randomUUID } from "node:crypto"
import { clampLimit, decodeCursor, encodeCursor } from "./pagination.js"
import {
  localPartOf,
  type InboundEmailInsert,
  type InboundRepository,
} from "./inbound-repository.drizzle.js"
import { toPreview } from "./mail-preview.js"
import type {
  InboundEmailDTO,
  InboundEmailListItemDTO,
  InboundEmailStatus,
  InboxListQuery,
  InboxListResponse,
} from "@civfix/shared"

interface StoredInbound extends InboundEmailInsert {
  id: string
  status: InboundEmailStatus
  receivedAt: Date
  archivedAt: Date | null
}

export interface RecordedInboxAudit {
  actorId: string | null
  action: "inbox.status_changed"
  target: string
  meta: { status: InboundEmailStatus; priorStatus: InboundEmailStatus }
}

export class InMemoryInboundRepository implements InboundRepository {
  readonly rows: StoredInbound[] = []
  readonly audits: RecordedInboxAudit[] = []
  private tick = 0

  private nextDate(base?: Date): Date {
    this.tick += 1
    return base ?? new Date(Date.UTC(2026, 0, 1) + this.tick * 1000)
  }

  insertIdempotent(input: InboundEmailInsert): Promise<{ id: string; inserted: boolean }> {
    const existing = this.rows.find((r) => r.messageId === input.messageId)
    if (existing) return Promise.resolve({ id: existing.id, inserted: false })
    const row: StoredInbound = {
      ...input,
      id: randomUUID(),
      status: "unread",
      receivedAt: input.receivedAt ?? this.nextDate(),
      archivedAt: null,
    }
    this.rows.push(row)
    return Promise.resolve({ id: row.id, inserted: true })
  }

  list(query: InboxListQuery): Promise<InboxListResponse> {
    const limit = clampLimit(query.limit)
    const anchor = decodeCursor(query.cursor)
    const q = query.q?.trim().toLowerCase()
    let filtered = this.rows.filter((r) => {
      if (query.status === "unread" && r.status !== "unread") return false
      if (query.status === "archived" && r.status !== "archived") return false
      if (query.localPart && localPartOf(r.recipient) !== query.localPart) return false
      if (q && q.length > 0) {
        const hay = `${r.fromAddr ?? ""} ${r.subject ?? ""} ${r.recipient ?? ""}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    filtered = filtered.sort((a, b) => {
      const d = b.receivedAt.getTime() - a.receivedAt.getTime()
      return d !== 0 ? d : (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
    })
    if (anchor) {
      filtered = filtered.filter((r) => {
        const t = r.receivedAt.getTime()
        const at = anchor.createdAt.getTime()
        return t < at || (t === at && r.id < anchor.id)
      })
    }
    const page = filtered.slice(0, limit)
    const hasMore = filtered.length > limit
    const last = page[page.length - 1]
    const nextCursor =
      hasMore && last ? encodeCursor({ createdAt: last.receivedAt, id: last.id }) : null
    return Promise.resolve({ items: page.map(toListItem), nextCursor })
  }

  get(id: string): Promise<InboundEmailDTO | null> {
    const row = this.rows.find((r) => r.id === id)
    return Promise.resolve(row ? toDTO(row) : null)
  }

  setStatus(
    id: string,
    status: InboundEmailStatus,
    actorId: string | null = null,
  ): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id)
    if (!row) return Promise.resolve(false)
    const priorStatus = row.status
    row.status = status
    row.archivedAt = status === "archived" ? (row.archivedAt ?? this.nextDate()) : null
    this.audits.push({
      actorId,
      action: "inbox.status_changed",
      target: `inbound_email:${id}`,
      meta: { status, priorStatus },
    })
    return Promise.resolve(true)
  }
}

function toListItem(r: StoredInbound): InboundEmailListItemDTO {
  return {
    id: r.id,
    from: r.fromAddr ?? "",
    recipient: r.recipient ?? "",
    localPart: localPartOf(r.recipient),
    subject: r.subject ?? "",
    preview: toPreview(r.bodyText, r.bodyHtml),
    ts: r.receivedAt.toISOString(),
    status: r.status,
    unread: r.status === "unread",
    hasAttachments: r.attachments.length > 0,
  }
}

function toDTO(r: StoredInbound): InboundEmailDTO {
  return {
    ...toListItem(r),
    bodyText: r.bodyText ?? "",
    bodyHtml: r.bodyHtml,
    messageId: r.messageId,
    attachments: r.attachments,
  }
}
