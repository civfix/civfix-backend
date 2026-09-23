
import type { CursorAnchor } from "./pagination.js"
import type { MailAuthVerdict } from "../../adapters/inbound-mail.cf.js"
import { MAIL_AUTH_VERDICT_VALUES } from "../../db/schema/types.js"
import { toPreview } from "./mail-preview.js"
import type {
  MailMessageKind,
  MailMessageRecord,
  MailThreadRecord,
  OutreachStateRecord,
} from "./mail-repository.js"
import type {
  MailAttachment,
  MailDelivery,
  MailDirection,
  MailMessageDTO,
  MailReplyPublication,
  MailStatus,
  MailThreadDTO,
  MailThreadListItemDTO,
} from "@civfix/shared"

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

export interface MessageRowSelect {
  id: string
  thread_id: string
  direction: MailDirection
  from_addr: string | null
  to_addr: string | null
  subject: string | null
  body: string | null
  html?: string | null
  kind?: MailMessageKind | null
  attachments: MailAttachment[] | null
  message_id: string | null
  in_reply_to: string | null
  unaffiliated: boolean
  effects_claimed_at: Date | null
  effects_applied_at: Date | null
  effects_stage: number
  auth_verdict?: string | null
  created_at: Date
  truncated?: boolean
  delivery?: MailDelivery | null
}

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

function isMailAuthVerdict(value: string): value is MailAuthVerdict {
  return (MAIL_AUTH_VERDICT_VALUES as readonly string[]).includes(value)
}

export function normalizeAuthVerdict(value: string | null | undefined): MailAuthVerdict | null {
  if (value === null || value === undefined) return null
  return isMailAuthVerdict(value) ? value : "unknown"
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
    html: r.html ?? null,
    kind: r.kind ?? null,
    attachments: r.attachments ?? [],
    messageId: r.message_id,
    inReplyTo: r.in_reply_to,
    unaffiliated: r.unaffiliated,
    effectsClaimedAt: r.effects_claimed_at,
    effectsAppliedAt: r.effects_applied_at,
    effectsStage: r.effects_stage,
    authVerdict: normalizeAuthVerdict(r.auth_verdict),
    createdAt: r.created_at,
    ...(r.truncated === true ? { truncated: true } : {}),
    delivery: r.delivery ?? null,
  }
}

export function toOutreachRecord(r: OutreachRowSelect): OutreachStateRecord {
  return {
    geoid: r.geoid,
    lastOutreachAt: r.last_outreach_at,
    suppressed: r.suppressed,
  }
}

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"

export function mintThreadToken(): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  let out = ""
  for (const b of bytes) out += TOKEN_ALPHABET[b & 31]
  return out
}

export function deriveWho(direction: MailDirection, fromAddr: string | null): string {
  if (fromAddr && fromAddr.length > 0) return fromAddr
  return direction === "in" ? "Inbound" : "civfix"
}

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
    preview: toPreview(latest?.body),
    ts,
    unread: thread.unread,
    status: thread.status,
    jurisdictionGeoid: thread.jurisdictionGeoid,
    reportId: thread.reportId,
  }
}

function deliveryOf(message: MailMessageRecord): MailDelivery | null {
  if (message.direction === "in") return null
  return message.delivery ?? "pending"
}

type PublicationThread = Pick<MailThreadRecord, "reportId" | "cleanupId">
type PublicationMessage = Pick<MailMessageRecord, "direction" | "unaffiliated" | "effectsAppliedAt">

export function replyPublication(
  thread: PublicationThread,
  message: PublicationMessage,
): MailReplyPublication | null {
  if (message.direction !== "in") return null
  if (thread.reportId === null && thread.cleanupId === null) return null
  if (message.effectsAppliedAt !== null) return "published"
  return message.unaffiliated ? "withheld" : "pending"
}

export function toMessageDTO(
  message: MailMessageRecord,
  thread: PublicationThread,
): MailMessageDTO {
  return {
    id: message.id,
    who: deriveWho(message.direction, message.fromAddr),
    from: message.fromAddr ?? "",
    to: message.toAddr ?? "",
    dir: message.direction,
    body: message.body ?? "",
    ts: message.createdAt.toISOString(),
    attachments: message.attachments,
    ...(message.truncated === true ? { truncated: true } : {}),
    delivery: deliveryOf(message),
    authVerdict: message.direction === "in" ? message.authVerdict : null,
    publication: replyPublication(thread, message),
  }
}

export function toThreadDTO(
  thread: MailThreadRecord,
  messages: MailMessageRecord[],
): MailThreadDTO {
  const latest = messages.length > 0 ? (messages[messages.length - 1] ?? null) : null
  return {
    ...toThreadListItem(thread, latest),
    messages: messages.map((message) => toMessageDTO(message, thread)),
  }
}

export function anchorOf(thread: MailThreadRecord): CursorAnchor {
  return { createdAt: thread.lastMessageAt ?? thread.createdAt, id: thread.id }
}
