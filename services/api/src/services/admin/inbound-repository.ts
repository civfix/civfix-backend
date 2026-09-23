import type {
  InboundEmailDTO,
  InboundEmailStatus,
  InboxListQuery,
  InboxListResponse,
  MailAttachment,
} from "@civfix/shared"

export interface InboundEmailInsert {
  messageId: string
  fromAddr: string | null
  toAddr: string | null
  recipient: string | null
  subject: string | null
  bodyText: string | null
  bodyHtml: string | null
  headers: Record<string, string>
  attachments: MailAttachment[]
  receivedAt?: Date
}

export interface InboundRepository {
  insertIdempotent(input: InboundEmailInsert): Promise<{ id: string; inserted: boolean }>
  list(query: InboxListQuery): Promise<InboxListResponse>
  get(id: string): Promise<InboundEmailDTO | null>
  setStatus(id: string, status: InboundEmailStatus, actorId: string | null): Promise<boolean>
  /** Counts one more failed bounce-bookkeeping run for a pending object; returns the new total. */
  recordBounceFailure(objectKey: string): Promise<number>
  clearBounceFailures(objectKey: string): Promise<void>
}
