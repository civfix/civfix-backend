/**
 * Pure mapping for the mail domain: SQL-row -> record, record -> @civfix/shared DTO, plus the keyset
 * anchor and the thread-token mint. No I/O; shared by the Drizzle impl and the in-memory fake.
 */

import type { CursorAnchor } from "./pagination.js"
import type {
  MailMessageRecord,
  MailThreadRecord,
  OutreachStateRecord,
} from "./mail-repository.js"
import type {
  MailAttachment,
  MailDirection,
  MailMessageDTO,
  MailStatus,
  MailThreadDTO,
  MailThreadListItemDTO,
} from "@civfix/shared"

/** A mail_threads row as selected back from SQL (snake_case). */
export interface ThreadRowSelect {
  id: string
  thread_token: string
  jurisdiction_geoid: string | null
  report_id: string | null
  cleanup_id: string | null
  org: string | null
  subject: string | null
  status: MailStatus
  unread: boolean
  last_message_at: Date | null
  created_at: Date
}

/** A mail_messages row as selected back from SQL. */
export interface MessageRowSelect {
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
export interface OutreachRowSelect {
  geoid: string
  last_outreach_at: Date | null
  suppressed: boolean
}

export function toThreadRecord(r: ThreadRowSelect): MailThreadRecord {
  return {
    id: r.id,
    threadToken: r.thread_token,
    jurisdictionGeoid: r.jurisdiction_geoid,
    reportId: r.report_id,
    cleanupId: r.cleanup_id,
    org: r.org,
    subject: r.subject,
    status: r.status,
    unread: r.unread,
    lastMessageAt: r.last_message_at,
    createdAt: r.created_at,
  }
}

export function toMessageRecord(r: MessageRowSelect): MailMessageRecord {
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

export function toOutreachRecord(r: OutreachRowSelect): OutreachStateRecord {
  return {
    geoid: r.geoid,
    lastOutreachAt: r.last_outreach_at,
    suppressed: r.suppressed,
  }
}

/** Lowercase base32 (RFC 4648) alphabet. 256 = 8x32, so `byte & 31` maps uniformly with no modulo bias. */
const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"

/**
 * Generate a thread token (used when a caller does not supply one): 12 lowercase base32 chars (~60 bits).
 * Address-safe + short enough to read socially in the per-thread From address ({kind}-{token}@domain) we
 * send to municipal staff, while leaving collisions astronomically unlikely (the UNIQUE thread_token index
 * is the backstop). Each char is drawn unbiased from the 32-char alphabet via `byte & 31`.
 */
export function mintThreadToken(): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  let out = ""
  for (const b of bytes) out += TOKEN_ALPHABET[b & 31]
  return out
}

/** A message's display "who": its address, or a direction-based fallback. */
export function deriveWho(direction: MailDirection, fromAddr: string | null): string {
  if (fromAddr && fromAddr.length > 0) return fromAddr
  return direction === "in" ? "Inbound" : "civfix"
}

/**
 * Map a thread + its latest message to MailThreadListItemDTO. `dir` falls back to "out" for a thread
 * with no messages yet (civfix originates outreach); `ts` is last_message_at (or created_at). Empty-string
 * fallbacks keep the DTO `.strict()` shape valid.
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
    to: latest?.toAddr ?? "",
    org: thread.org ?? "",
    subject: thread.subject ?? "",
    preview: latest?.body ?? "",
    ts,
    unread: thread.unread,
    status: thread.status,
    jurisdictionGeoid: thread.jurisdictionGeoid,
    // Cross-entity clickability: the originating report for an outreach thread (null for inbound/cold
    // threads that were not spawned from a report). Flows into MailThreadDTO via the toThreadDTO spread.
    reportId: thread.reportId,
  }
}

export function toMessageDTO(message: MailMessageRecord): MailMessageDTO {
  return {
    id: message.id,
    who: deriveWho(message.direction, message.fromAddr),
    from: message.fromAddr ?? "",
    // The OUT row's to_addr; empty for inbound (we are the recipient) or when unknown — it lets the admin
    // reader name who an outbound-only thread was sent to.
    to: message.toAddr ?? "",
    dir: message.direction,
    body: message.body ?? "",
    ts: message.createdAt.toISOString(),
    attachments: message.attachments,
  }
}

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

/** The keyset anchor for a thread (the coalesced last_message_at/created_at sort key + id tiebreak). */
export function anchorOf(thread: MailThreadRecord): CursorAnchor {
  return { createdAt: thread.lastMessageAt ?? thread.createdAt, id: thread.id }
}
