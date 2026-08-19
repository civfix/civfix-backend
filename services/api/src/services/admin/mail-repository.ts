
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
  reportId: string | null
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
  truncated?: boolean
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
  attachments?: MailAttachment[]
  messageId?: string | null
  inReplyTo?: string | null
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
  stats7d(): Promise<MailStatsResponse>
  getOutreachState(geoid: string): Promise<OutreachStateRecord | null>
  setOutreachState(geoid: string, patch: OutreachStatePatch): Promise<OutreachStateRecord>
  getThreadRecord(id: string): Promise<MailThreadRecord | null>
  findOrCreateReportThread(reportId: string, init?: ThreadInit): Promise<MailThreadRecord>
  findOrCreateEventThread(cleanupId: string, init?: ThreadInit): Promise<MailThreadRecord>
  priorOutboundMessageIds(threadId: string): Promise<string[]>
  upsertThreadByGeoid(geoid: string, init?: ThreadInit): Promise<MailThreadRecord>
  findThreadByToken(token: string): Promise<MailThreadRecord | null>
  findThreadByOutboundMessageIds(messageIds: string[]): Promise<MailThreadRecord | null>
  getLastOutboundRecipient(threadId: string): Promise<string | null>
  getLastInboundSender(threadId: string): Promise<string | null>
  outboundRecipients(threadId: string): Promise<string[]>
}

export const MAIL_STATS_WINDOW_DAYS = 7
