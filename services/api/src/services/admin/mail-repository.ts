
import type { AdminAuditAction } from "./audit.js"
import type { MailAuthVerdict } from "../../adapters/inbound-mail.cf.js"
import type {
  MailAttachment,
  MailDelivery,
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
  reportId: string | null
  cleanupId: string | null
  org: string | null
  subject: string | null
  status: MailStatus
  unread: boolean
  lastMessageAt: Date | null
  createdAt: Date
}

export type MailMessageKind =
  | "packet"
  | "discussion"
  | "followup"
  | "digest"
  | "compose"
  | "reply"
  | "resend"

export function isPacketKind(kind: MailMessageKind | null): boolean {
  return (kind ?? "packet") === "packet"
}

export interface MailMessageRecord {
  id: string
  threadId: string
  direction: MailDirection
  fromAddr: string | null
  toAddr: string | null
  subject: string | null
  body: string | null
  html: string | null
  kind: MailMessageKind | null
  attachments: MailAttachment[]
  messageId: string | null
  inReplyTo: string | null
  unaffiliated: boolean
  effectsClaimedAt: Date | null
  effectsAppliedAt: Date | null
  effectsStage: number
  authVerdict: MailAuthVerdict | null
  createdAt: Date
  truncated?: boolean
  delivery?: MailDelivery | null
}

export type MailEventType = "sent" | "delivered" | "bounced" | "complained" | "opened" | "failed"

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
  html?: string | null
  kind?: MailMessageKind | null
  attachments?: MailAttachment[]
  messageId?: string | null
  inReplyTo?: string | null
  unaffiliated?: boolean
  authVerdict?: MailAuthVerdict | null
  threadStatus?: MailStatus
  audit?: MailAuditInput
}

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

export interface RecordSendFailureInput {
  threadId: string
  messageId: string
  meta: Record<string, unknown>
  audit?: MailAuditInput
}

export interface OutboundMessageSnapshot {
  id: string
  toAddr: string | null
  subject: string | null
  body: string
  html: string | null
  attachments: MailAttachment[]
}

export interface RecordEventInput {
  threadId?: string | null
  messageId?: string | null
  type: MailEventType
  meta?: Record<string, unknown> | null
}

export interface OutreachStatePatch {
  lastOutreachAt?: Date | null
  suppressed?: boolean
}

export interface MailRepository {
  upsertThreadByToken(token: string, init?: ThreadInit): Promise<MailThreadRecord>
  createThread(input: CreateThreadInput): Promise<MailThreadRecord>
  insertMessage(input: InsertMessageInput): Promise<MailMessageRecord | null>
  setMessageMessageId(id: string, rfcMessageId: string): Promise<void>
  listThreads(input: ListThreadsInput): Promise<ListThreadsResult>
  getThread(id: string): Promise<MailThreadDTO | null>
  markThreadRead(id: string): Promise<boolean>
  setThreadStatus(id: string, status: MailStatus, audit?: MailAuditInput): Promise<boolean>
  recordEvent(input: RecordEventInput): Promise<string>
  recordSendFailure(input: RecordSendFailureInput): Promise<void>
  setThreadSubject(id: string, subject: string): Promise<void>
  latestOutboundMessageId(threadId: string): Promise<string | null>
  getOutboundMessageForResend(messageId: string): Promise<OutboundMessageSnapshot | null>
  stats7d(): Promise<MailStatsResponse>
  getOutreachState(geoid: string): Promise<OutreachStateRecord | null>
  setOutreachState(geoid: string, patch: OutreachStatePatch): Promise<OutreachStateRecord>
  getThreadRecord(id: string): Promise<MailThreadRecord | null>
  findOrCreateReportThread(reportId: string, init?: ThreadInit): Promise<MailThreadRecord>
  findReportThread(reportId: string): Promise<MailThreadRecord | null>
  findOrCreateEventThread(cleanupId: string, init?: ThreadInit): Promise<MailThreadRecord>
  priorOutboundMessageIds(threadId: string): Promise<string[]>
  upsertThreadByGeoid(geoid: string, init?: ThreadInit): Promise<MailThreadRecord>
  findThreadByToken(token: string): Promise<MailThreadRecord | null>
  findThreadByOutboundMessageIds(messageIds: string[]): Promise<MailThreadRecord | null>
  getLastOutboundRecipient(threadId: string): Promise<string | null>
  outboundRecipients(threadId: string): Promise<string[]>
  findMessageByMessageId(messageId: string): Promise<MailMessageRecord | null>
  hasSendInFlight(threadId: string): Promise<boolean>
  claimMessageEffects(id: string, input: ClaimEffectsInput): Promise<number | null>
  setMessageEffectsStage(id: string, stage: number): Promise<void>
  markMessageEffectsApplied(id: string): Promise<void>
  releaseMessageEffects(id: string): Promise<void>
  settleRepliedThread(input: SettleRepliedThreadInput): Promise<void>
  settleThreadStatus(input: SettleThreadStatusInput): Promise<void>
  findMessagesPendingEffects(input: PendingEffectsQuery): Promise<PendingEffects[]>
  hasWithheldReply(threadId: string): Promise<boolean>
  findInboundMessage(threadId: string, messageId: string): Promise<MailMessageRecord | null>
  approveWithheldReply(messageId: string, audit: MailAuditInput): Promise<MailMessageRecord | null>
}

export interface ClaimEffectsInput {
  leaseBefore: Date
}

export interface SettleThreadStatusInput {
  threadId: string
  flag?: MailAuditInput
}

export interface SettleRepliedThreadInput extends SettleThreadStatusInput {
  messageId: string
  stage: number
}

export interface PendingEffectsQuery {
  before: Date
  leaseBefore: Date
  limit: number
}

export interface PendingEffects {
  message: MailMessageRecord
  thread: MailThreadRecord
}

export const MAIL_STATS_WINDOW_DAYS = 7
