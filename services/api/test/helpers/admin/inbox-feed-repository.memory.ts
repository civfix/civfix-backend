import type { InboxFeedFilter, InboxFeedQuery, InboxFeedResponse } from "@civfix/shared"
import { clampLimit } from "../../../src/services/admin/pagination.js"
import { parseTimeCursor, type TimeCursor } from "../../../src/db/cursor-helpers.js"
import { INBOUND_AUTH_VERDICT_HEADER } from "../../../src/services/admin/inbound-repository.drizzle.js"
import type { InMemoryInboundRepository } from "./inbound-repository.memory.js"
import type { InMemoryMailRepository } from "./mail-repository.memory.js"
import { replyPublication } from "../../../src/services/admin/mail-mappers.js"
import {
  INBOX_FEED_EMAIL_FILTERS,
  INBOX_FEED_REPLY_FILTERS,
  toInboxFeedPage,
  type InboxFeedRepository,
  type InboxFeedRow,
} from "../../../src/services/admin/inbox-feed-repository.drizzle.js"

type Matches = (...fields: (string | null)[]) => boolean

export class InMemoryInboxFeedRepository implements InboxFeedRepository {
  constructor(
    private readonly inbound: InMemoryInboundRepository,
    private readonly mail: InMemoryMailRepository,
  ) {}

  list(query: InboxFeedQuery): Promise<InboxFeedResponse> {
    const filter = query.filter ?? "all"
    const limit = clampLimit(query.limit)
    const anchor = parseTimeCursor(query.cursor)
    const q = query.q?.trim().toLowerCase() ?? ""
    const matches: Matches = (...fields) =>
      q === "" || fields.some((field) => (field ?? "").toLowerCase().includes(q))
    const rows = [
      ...(INBOX_FEED_EMAIL_FILTERS.has(filter) ? this.emailRows(filter, matches) : []),
      ...(INBOX_FEED_REPLY_FILTERS.has(filter) ? this.replyRows(filter, matches) : []),
    ]
    const page = rows
      .filter((row) => anchor === null || isBefore(row, anchor))
      .sort(newestFirst)
      .slice(0, limit + 1)
    return Promise.resolve(toInboxFeedPage(page, limit))
  }

  private emailRows(filter: InboxFeedFilter, matches: Matches): InboxFeedRow[] {
    return this.inbound.rows
      .filter((r) => (filter !== "unread" && filter !== "archived") || r.status === filter)
      .filter((r) => matches(r.fromAddr, r.subject, r.recipient))
      .map((r) => ({
        source: "email",
        id: r.id,
        ts: r.receivedAt,
        cursor_at: r.receivedAt.toISOString(),
        from_addr: r.fromAddr,
        recipient: r.recipient,
        subject: r.subject,
        preview_text: r.bodyText,
        preview_html: r.bodyHtml,
        has_attachments: r.attachments.length > 0,
        status: r.status,
        auth_verdict: r.headers[INBOUND_AUTH_VERDICT_HEADER] ?? null,
      }))
  }

  private replyRows(filter: InboxFeedFilter, matches: Matches): InboxFeedRow[] {
    const rows: InboxFeedRow[] = []
    for (const m of this.mail.messages) {
      const t = this.mail.threads.get(m.threadId)
      if (m.direction !== "in" || t === undefined) continue
      if (filter === "unread" && !t.unread) continue
      const awaitingReview = replyPublication(t, m) === "withheld" && t.status === "needs_action"
      if (filter === "review" && !awaitingReview) continue
      if (!matches(m.fromAddr, m.subject, t.subject, t.org)) continue
      rows.push({
        source: "reply",
        id: m.id,
        ts: m.createdAt,
        cursor_at: m.createdAt.toISOString(),
        from_addr: m.fromAddr,
        subject: m.subject ?? t.subject,
        preview_text: m.body,
        has_attachments: m.attachments.length > 0,
        auth_verdict: m.authVerdict,
        thread_id: t.id,
        report_id: t.reportId,
        cleanup_id: t.cleanupId,
        org: t.org,
        thread_unread: t.unread,
        thread_status: t.status,
        unaffiliated: m.unaffiliated,
        effects_applied_at: m.effectsAppliedAt,
      })
    }
    return rows
  }
}

function isBefore(row: InboxFeedRow, anchor: TimeCursor): boolean {
  const ts = row.ts.getTime()
  const at = anchor.at.getTime()
  return ts < at || (ts === at && row.id < anchor.id)
}

function newestFirst(a: InboxFeedRow, b: InboxFeedRow): number {
  const d = b.ts.getTime() - a.ts.getTime()
  if (d !== 0) return d
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}
