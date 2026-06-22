/**
 * The mail / outreach persistence seam (interface + record/input shapes; zero runtime).
 *
 * ALL mail thread / message / event / outreach-state access flows through MailRepository so the mail
 * routers and the OutboundMailService stay infra-free and unit-testable against the in-memory repo. The
 * production binding is makeDrizzleMailRepository (mail-repository.drizzle.ts); the fake is
 * InMemoryMailRepository (mail-repository.memory.ts). Both import these shapes from here.
 */

import type { AdminAuditAction } from "./audit.js"
import type {
  MailAttachment,
  MailDirection,
  MailStatsResponse,
  MailStatus,
  MailThreadDTO,
  MailThreadListItemDTO,
} from "@civfix/shared"

export interface MailThreadRecord {
  id: string
  threadToken: string
  jurisdictionGeoid: string | null
  /** The originating report (per-report outreach threads), or null for digest/compose/event threads. */
  reportId: string | null
  /** The originating cleanup/event (per-event resource-request threads), or null otherwise (D10/D19). */
  cleanupId: string | null
  org: string | null
  subject: string | null
  status: MailStatus
  unread: boolean
  lastMessageAt: Date | null
  createdAt: Date
}

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

/** The OCI delivery event type (`failed` = a send the mailer rejected, recorded for the outreach trail). */
export type MailEventType = "sent" | "delivered" | "bounced" | "complained" | "opened" | "failed"

/** The per-jurisdiction outreach throttle + manual opt-out. */
export interface OutreachStateRecord {
  geoid: string
  lastOutreachAt: Date | null
  suppressed: boolean
}

export interface ThreadInit {
  jurisdictionGeoid?: string | null
  reportId?: string | null
  cleanupId?: string | null
  org?: string | null
  subject?: string | null
  status?: MailStatus
  unread?: boolean
}

export interface CreateThreadInput {
  threadToken?: string
  jurisdictionGeoid?: string | null
  reportId?: string | null
  cleanupId?: string | null
  org?: string | null
  subject?: string | null
  status?: MailStatus
  unread?: boolean
}

/**
 * An optional operator-audit row written IN THE SAME transaction as a mail mutation (H4): so a mail send
 * / status change and its audit_log row are atomic. Omitted for system writes (the inbound webhook, the
 * outreach worker) which audit separately or not at all.
 */
export interface MailAuditInput {
  actorId: string | null
  action: AdminAuditAction
  target: string
  meta?: Record<string, unknown> | null
}

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

/** `filter:"attn"` returns only needs-attention threads (unread OR needs_action/bounced). */
export interface ListThreadsInput {
  dir?: MailDirection
  filter?: "attn"
  jurisdictionGeoid?: string
  q?: string
  cursor?: string | null
  limit?: number
}

export interface ListThreadsResult {
  items: MailThreadListItemDTO[]
  nextCursor: string | null
}

/** thread_id / message_id are optional (an event may arrive before correlation). */
export interface RecordEventInput {
  threadId?: string | null
  messageId?: string | null
  type: MailEventType
  meta?: Record<string, unknown> | null
}

/** Only the provided fields are written. */
export interface OutreachStatePatch {
  lastOutreachAt?: Date | null
  suppressed?: boolean
}

export interface MailRepository {
  /** Find a thread by its token, or create one (with `init`) when absent. */
  upsertThreadByToken(token: string, init?: ThreadInit): Promise<MailThreadRecord>
  /** Insert a thread, minting a thread_token when absent. */
  createThread(input: CreateThreadInput): Promise<MailThreadRecord>
  /** Insert a message + bump last_message_at; an inbound message sets thread.unread. */
  insertMessage(input: InsertMessageInput): Promise<MailMessageRecord>
  /**
   * Stamp the RFC822 Message-ID on an existing mail_messages row (the OUT row just inserted). The
   * outbound id is derived from the row id, so it can only be set after the insert; storing it lets an
   * eventual reply or bounce correlate by In-Reply-To/References.
   */
  setMessageMessageId(id: string, rfcMessageId: string): Promise<void>
  /** Keyset-paginated thread list mapped to MailThreadListItemDTO (newest first). */
  listThreads(input: ListThreadsInput): Promise<ListThreadsResult>
  getThread(id: string): Promise<MailThreadDTO | null>
  /** Clear the unread flag. True when the thread existed. */
  markThreadRead(id: string): Promise<boolean>
  /** Set status, optionally writing an audit row in the SAME tx (H4). True when it existed. */
  setThreadStatus(id: string, status: MailStatus, audit?: MailAuditInput): Promise<boolean>
  recordEvent(input: RecordEventInput): Promise<string>
  /** Deliverability + mailbox stats over a rolling MAIL_STATS_WINDOW_DAYS window. */
  stats7d(): Promise<MailStatsResponse>
  getOutreachState(geoid: string): Promise<OutreachStateRecord | null>
  setOutreachState(geoid: string, patch: OutreachStatePatch): Promise<OutreachStateRecord>
  getThreadRecord(id: string): Promise<MailThreadRecord | null>
  /**
   * The newest thread WHERE report_id = $1, or a freshly created thread (minted token + `init`) when none
   * exists. So a report's outreach is ONE conversation and a jurisdiction reply (via that thread's reply
   * token) auto-routes back onto it.
   */
  findOrCreateReportThread(reportId: string, init?: ThreadInit): Promise<MailThreadRecord>
  /**
   * The newest thread WHERE cleanup_id = $1, or a freshly created thread (minted token + `init`) when none
   * exists (D10/D19). So an event's resource request is ONE conversation and a city reply (via that
   * thread's event+ reply token) auto-routes back onto the cleanup (onEventReply -> cleanup_timeline).
   */
  findOrCreateEventThread(cleanupId: string, init?: ThreadInit): Promise<MailThreadRecord>
  /**
   * The thread's prior OUTBOUND Message-IDs (those already stamped), oldest-first. The threading chain for
   * a follow-up: In-Reply-To = the last, References = the whole list (D14). Excludes the just-inserted OUT
   * row (its message_id is stamped only AFTER delivery). Empty for the first message on a thread.
   */
  priorOutboundMessageIds(threadId: string): Promise<string[]>
  /**
   * The newest thread WHERE jurisdiction_geoid = $1 AND report_id IS NULL, or a freshly created one with a
   * minted token. Replaces the old `geo-{geoid}` token scheme (which failed the real inbound reply-token
   * regex), keeping one rolling digest thread per jurisdiction while leaving per-report threads untouched.
   */
  upsertThreadByGeoid(geoid: string, init?: ThreadInit): Promise<MailThreadRecord>
  /** Read a thread by its reply token. Used by the bounce/inbound correlation paths. */
  findThreadByToken(token: string): Promise<MailThreadRecord | null>
  /**
   * The newest thread holding an OUTBOUND mail_messages.message_id in the given set, or null. The inbound
   * fallback: a reply that stripped the plus-address token still correlates via the In-Reply-To /
   * References headers it echoes back. Bounded (empty set -> null).
   */
  findThreadByOutboundMessageIds(messageIds: string[]): Promise<MailThreadRecord | null>
  /**
   * The to_addr of the thread's most recent OUTBOUND message, or null. M1: this is the recipient for a
   * reply/resend on an outbound-only thread (operator -> city) before any inbound reply — the recipient
   * lives on the OUT row's to_addr, which is not carried on MailMessageDTO.
   */
  getLastOutboundRecipient(threadId: string): Promise<string | null>
  /**
   * True when a mail_messages row already carries this message_id. The inbound processor's idempotency
   * guard for the threaded path: a re-delivered reply (webhook + sweep racing the same R2 object) is
   * skipped rather than inserted twice. (The catch-all path dedups via the inbound_emails UNIQUE index.)
   */
  messageExists(messageId: string): Promise<boolean>
}

/** Rolling window (days) the deliverability stats aggregate over. */
export const MAIL_STATS_WINDOW_DAYS = 7
