import { AppError, ErrorCode } from "@civfix/shared"
import type { Mailer, OutboundAttachment, SentMail } from "@civfix/shared/interfaces"
import type { DbHandle } from "../../db/client.js"
import type { Env } from "../../env/types.js"
import {
  makeDrizzleMailRepository,
  type MailAuditInput,
  type MailMessageKind,
  type MailMessageRecord,
  type MailRepository,
  type MailThreadRecord,
} from "./mail-repository.drizzle.js"
import type { MailAttachment, MailStatus } from "@civfix/shared"
import { domainOf } from "../../adapters/mail-text.js"
import {
  base64Bytes,
  outboundSendDeadlineMs,
  phaseBudgetFor,
  OUTBOUND_SEND_MIN_THROUGHPUT_BPS,
  OUTBOUND_SEND_PHASE_BUDGET_MS,
} from "./outbound-send-policy.js"

export interface OutboundMailEnv {
  MAIL_FROM_OUTREACH: string
  MAIL_REPLY_DOMAIN: string
}

export interface PacketAttachment extends OutboundAttachment {
  key?: string
}

export interface OutboundMailLogger {
  warn(obj: unknown, msg?: string): void
}

export interface ReportContext {
  reportId?: string
  category?: string
  place?: string
}

export interface SendToCityInput {
  geoid?: string | null
  toAddr: string
  subject: string
  body: string
  reportContext?: ReportContext
  org?: string | null
}

export type OutboundAudit = Omit<MailAuditInput, "target">

export interface ComposeInput {
  to: string
  subject: string
  body: string
  audit?: OutboundAudit
}

export interface AppendOutboundInput {
  body: string
  toAddr: string
  subject?: string
  html?: string
  attachments?: PacketAttachment[]
  kind?: MailMessageKind
  audit?: OutboundAudit
  eventMeta?: Record<string, unknown>
}

export interface SendReportInput {
  reportId: string
  geoid: string | null
  org?: string | null
  toAddr: string
  subject: string
  text: string
  html?: string
  attachments?: PacketAttachment[]
  kind?: MailMessageKind
  audit?: MailAuditInput
}

export interface SendEventInput {
  cleanupId: string
  geoid: string | null
  org?: string | null
  toAddr: string
  subject: string
  text: string
  html?: string
}

export interface DeliverOptions {
  onLateSuccess?: () => Promise<void>
}

export interface PreparedReportOutbound {
  thread: MailThreadRecord
  deliver(opts?: DeliverOptions): Promise<{ thread: MailThreadRecord; messageId: string }>
}

export interface OutboundMailService {
  sendToCity(input: SendToCityInput): Promise<MailThreadRecord>
  findReportThread(reportId: string): Promise<MailThreadRecord | null>
  prepareReportToJurisdiction(input: SendReportInput): Promise<PreparedReportOutbound>
  sendReportToJurisdiction(
    input: SendReportInput,
  ): Promise<{ thread: MailThreadRecord; messageId: string }>
  sendEventToJurisdiction(
    input: SendEventInput,
  ): Promise<{ thread: MailThreadRecord; messageId: string }>
  compose(input: ComposeInput): Promise<MailThreadRecord>
  appendOutbound(threadId: string, input: AppendOutboundInput): Promise<MailThreadRecord>
}

export interface OutboundMailServiceDeps {
  repo: MailRepository
  mailer: Mailer
  env: OutboundMailEnv
  logger?: OutboundMailLogger
  sendDeadlineMs?: number
  sendPhaseBudgetMs?: number
  sendMinThroughputBytesPerSec?: number
}

export const OUTBOUND_DEADLINE_REASON = "deadline"

const THREAD_STATUS_CLEARED_BY_DELIVERY: readonly MailStatus[] = ["needs_action", "bounced"]

export class OutboundSendDeadlineError extends AppError {
  readonly outboundSendDeadline = true
  readonly deadlineMs: number

  constructor(deadlineMs: number) {
    super(
      ErrorCode.CONFLICT,
      "The send to this jurisdiction is still in progress. Its outcome will appear on the outreach " +
        "trail once the mail server answers, so check back shortly.",
    )
    this.deadlineMs = deadlineMs
  }
}

export function isOutboundSendDeadlineError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  return (err as { outboundSendDeadline?: unknown }).outboundSendDeadline === true
}

export function attachmentMetadata(
  attachments: readonly PacketAttachment[] | undefined,
): MailAttachment[] {
  const stored: MailAttachment[] = []
  for (const att of attachments ?? []) {
    if (att.key === undefined || att.key === "") continue
    stored.push({ key: att.key, filename: att.filename, size: att.content.byteLength })
  }
  return stored
}

export function outboundPayloadBytes(input: {
  body: string
  html?: string | undefined
  attachments?: readonly OutboundAttachment[] | undefined
}): number {
  let bytes = Buffer.byteLength(input.body, "utf8")
  if (input.html !== undefined) bytes += Buffer.byteLength(input.html, "utf8")
  let attachmentBytes = 0
  for (const att of input.attachments ?? []) attachmentBytes += att.content.byteLength
  return bytes + base64Bytes(attachmentBytes)
}

function raceDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new OutboundSendDeadlineError(ms)), ms)
  })
  return Promise.race([work, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  }) as Promise<T>
}

export function makeOutboundMailService(deps: OutboundMailServiceDeps): OutboundMailService {
  const { repo, mailer, env } = deps
  const logger: OutboundMailLogger = deps.logger ?? console
  const phaseBudgetMs = deps.sendPhaseBudgetMs ?? OUTBOUND_SEND_PHASE_BUDGET_MS
  const minThroughput = deps.sendMinThroughputBytesPerSec ?? OUTBOUND_SEND_MIN_THROUGHPUT_BPS

  function fromHeaderForThread(thread: MailThreadRecord): string {
    const domain = env.MAIL_REPLY_DOMAIN
    const token = thread.threadToken
    if (thread.reportId !== null) return `"civfix Reports" <report-${token}@${domain}>`
    if (thread.cleanupId !== null) return `"civfix Cleanups" <event-${token}@${domain}>`
    return `"civfix" <reply-${token}@${domain}>`
  }

  async function deliverAndRecord(args: {
    threadId: string
    messageId: string
    fromHeader: string
    toAddr: string
    subject: string
    body: string
    html?: string
    attachments?: PacketAttachment[]
    eventMeta?: Record<string, unknown>
    onLateSuccess?: (() => Promise<void>) | undefined
  }): Promise<string> {
    const rfcMessageId = `<out-${args.messageId}@${domainOf(env.MAIL_FROM_OUTREACH)}>`
    // Threading headers are a courtesy to the city's mail client; losing them must not block the send.
    const priorIds = await repo
      .priorOutboundMessageIds(args.threadId)
      .catch((err: unknown): string[] => {
        logger.warn(
          { err, threadId: args.threadId },
          "outbound mail: prior Message-IDs unreadable; sending without In-Reply-To/References",
        )
        return []
      })
    const inReplyTo = priorIds.length > 0 ? priorIds[priorIds.length - 1] : undefined
    const references =
      priorIds.length > 10 ? [priorIds[0] as string, ...priorIds.slice(-9)] : priorIds
    const bytes = outboundPayloadBytes({
      body: args.body,
      html: args.html,
      attachments: args.attachments,
    })
    const deadlineMs =
      deps.sendDeadlineMs ??
      outboundSendDeadlineMs({
        bytes,
        phaseBudgetMs,
        minThroughputBytesPerSec: minThroughput,
      })

    const send = mailer.sendOutbound({
      from: args.fromHeader,
      to: args.toAddr,
      subject: args.subject,
      text: args.body,
      ...(args.html !== undefined ? { html: args.html } : {}),
      messageId: rfcMessageId,
      ...(inReplyTo !== undefined ? { inReplyTo } : {}),
      ...(references.length > 0 ? { references } : {}),
      ...(args.attachments !== undefined ? { attachments: args.attachments } : {}),
    })

    async function recordFailed(err: unknown, extra: Record<string, unknown>): Promise<void> {
      const error = err instanceof Error ? err.message : String(err)
      const reportId = args.eventMeta?.reportId
      try {
        await repo.recordSendFailure({
          threadId: args.threadId,
          messageId: args.messageId,
          meta: {
            from: args.fromHeader,
            to: args.toAddr,
            error,
            ...extra,
            ...(args.eventMeta ?? {}),
          },
          ...(typeof reportId === "string" && reportId.length > 0
            ? {
                audit: {
                  actorId: null,
                  action: "mail.send_failed" as const,
                  target: `report:${reportId}`,
                  meta: {
                    threadId: args.threadId,
                    messageId: args.messageId,
                    to: args.toAddr,
                    reportId,
                    error,
                  },
                },
              }
            : {}),
        })
      } catch (recordErr) {
        logger.warn(
          { err: recordErr, threadId: args.threadId, messageId: args.messageId },
          "outbound mail send failed AND recording the 'failed' event failed",
        )
      }
    }

    async function recordSent(result: SentMail, extra: Record<string, unknown>): Promise<void> {
      await repo.setMessageMessageId(args.messageId, result.messageId)
      await repo.recordEvent({
        threadId: args.threadId,
        messageId: args.messageId,
        type: "sent",
        meta: {
          from: args.fromHeader,
          to: args.toAddr,
          ...extra,
          ...(args.eventMeta ?? {}),
        },
      })
      await clearDeliveryFailureStatus()
    }

    async function clearDeliveryFailureStatus(): Promise<void> {
      try {
        const fresh = await repo.getThreadRecord(args.threadId)
        if (fresh === null || !THREAD_STATUS_CLEARED_BY_DELIVERY.includes(fresh.status)) return
        await repo.setThreadStatus(args.threadId, "sent")
      } catch (err) {
        logger.warn(
          { err, threadId: args.threadId, messageId: args.messageId },
          "outbound mail delivered but clearing the thread's failure status failed",
        )
      }
    }

    let sent: SentMail
    try {
      sent = await raceDeadline(send, deadlineMs)
    } catch (err) {
      if (!isOutboundSendDeadlineError(err)) {
        await recordFailed(err, {})
        throw err
      }
      const failureWrite = recordFailed(err, {
        reason: OUTBOUND_DEADLINE_REASON,
        deadlineMs,
        bytes,
      })
      void send.then(
        async (late: SentMail) => {
          try {
            // The caller already awaits failureWrite and sees its error; here it only orders the
            // late 'sent' after the 'failed' row.
            await failureWrite.catch(() => {})
            await recordSent(late, { late: true })
            if (args.onLateSuccess !== undefined) await args.onLateSuccess()
            logger.warn(
              { threadId: args.threadId, messageId: args.messageId, deadlineMs },
              "outbound mail delivered AFTER its deadline; recorded 'sent' (late)",
            )
          } catch (recordErr) {
            logger.warn(
              { err: recordErr, threadId: args.threadId, messageId: args.messageId },
              "outbound mail delivered late but recording the 'sent' event failed",
            )
          }
        },
        (lateErr: unknown) => {
          logger.warn(
            { err: lateErr, threadId: args.threadId, messageId: args.messageId, deadlineMs },
            "outbound mail rejected AFTER its deadline; the 'failed' event already recorded stands",
          )
        },
      )
      await failureWrite
      throw err
    }
    try {
      await recordSent(sent, {})
    } catch (err) {
      logger.warn(
        { err, threadId: args.threadId, messageId: args.messageId },
        "outbound mail delivered but post-send write failed (Message-ID/'sent' may be missing)",
      )
    }
    return sent.messageId
  }

  async function insertOut(
    input: Parameters<MailRepository["insertMessage"]>[0],
  ): Promise<MailMessageRecord> {
    const message = await repo.insertMessage(input)
    if (message === null) {
      throw new Error("insertMessage: unexpected message_id conflict on an outbound insert")
    }
    return message
  }

  async function freshThread(thread: MailThreadRecord): Promise<MailThreadRecord> {
    try {
      const fresh = await repo.getThreadRecord(thread.id)
      if (fresh === null) {
        logger.warn(
          { threadId: thread.id },
          "outbound mail: thread re-read returned null; using stale record",
        )
      }
      return fresh ?? thread
    } catch (err) {
      logger.warn(
        { err, threadId: thread.id },
        "outbound mail: thread re-read threw after delivery; using stale record",
      )
      return thread
    }
  }

  async function prepareReport(input: SendReportInput): Promise<PreparedReportOutbound> {
    const thread = await repo.findOrCreateReportThread(input.reportId, {
      jurisdictionGeoid: input.geoid,
      org: input.org ?? null,
      subject: input.subject,
      status: "sent",
    })
    if (thread.subject !== input.subject) {
      await repo.setThreadSubject(thread.id, input.subject)
      thread.subject = input.subject
    }
    const fromHeader = fromHeaderForThread(thread)
    const attachments = attachmentMetadata(input.attachments)
    const message = await insertOut({
      threadId: thread.id,
      direction: "out",
      fromAddr: fromHeader,
      toAddr: input.toAddr,
      subject: input.subject,
      body: input.text,
      kind: input.kind ?? "packet",
      ...(input.html !== undefined ? { html: input.html } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(input.audit
        ? {
            audit: {
              ...input.audit,
              meta: { ...(input.audit.meta ?? {}), threadId: thread.id, to: input.toAddr },
            },
          }
        : {}),
    })
    return {
      thread,
      async deliver(
        opts?: DeliverOptions,
      ): Promise<{ thread: MailThreadRecord; messageId: string }> {
        const messageId = await deliverAndRecord({
          ...(opts?.onLateSuccess !== undefined ? { onLateSuccess: opts.onLateSuccess } : {}),
          threadId: thread.id,
          messageId: message.id,
          fromHeader,
          toAddr: input.toAddr,
          subject: input.subject,
          body: input.text,
          ...(input.html !== undefined ? { html: input.html } : {}),
          ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
          eventMeta: {
            reportId: input.reportId,
            ...(input.geoid != null ? { geoid: input.geoid } : {}),
          },
        })
        return { thread: await freshThread(thread), messageId }
      },
    }
  }

  return {
    findReportThread(reportId: string): Promise<MailThreadRecord | null> {
      return repo.findReportThread(reportId)
    },

    prepareReportToJurisdiction(input: SendReportInput): Promise<PreparedReportOutbound> {
      return prepareReport(input)
    },

    async sendReportToJurisdiction(
      input: SendReportInput,
    ): Promise<{ thread: MailThreadRecord; messageId: string }> {
      const prepared = await prepareReport(input)
      return prepared.deliver()
    },

    async sendEventToJurisdiction(
      input: SendEventInput,
    ): Promise<{ thread: MailThreadRecord; messageId: string }> {
      const thread = await repo.findOrCreateEventThread(input.cleanupId, {
        jurisdictionGeoid: input.geoid,
        org: input.org ?? null,
        subject: input.subject,
        status: "sent",
      })
      const fromHeader = fromHeaderForThread(thread)
      const message = await insertOut({
        threadId: thread.id,
        direction: "out",
        fromAddr: fromHeader,
        toAddr: input.toAddr,
        subject: input.subject,
        body: input.text,
        kind: "packet",
        ...(input.html !== undefined ? { html: input.html } : {}),
      })
      const messageId = await deliverAndRecord({
        threadId: thread.id,
        messageId: message.id,
        fromHeader,
        toAddr: input.toAddr,
        subject: input.subject,
        body: input.text,
        ...(input.html !== undefined ? { html: input.html } : {}),
        eventMeta: {
          cleanupId: input.cleanupId,
          ...(input.geoid != null ? { geoid: input.geoid } : {}),
        },
      })
      return { thread: await freshThread(thread), messageId }
    },

    async sendToCity(input: SendToCityInput): Promise<MailThreadRecord> {
      const thread =
        input.geoid != null && input.geoid.length > 0
          ? await repo.upsertThreadByGeoid(input.geoid, {
              jurisdictionGeoid: input.geoid,
              org: input.org ?? null,
              subject: input.subject,
              status: "sent",
            })
          : await repo.createThread({
              jurisdictionGeoid: input.geoid ?? null,
              org: input.org ?? null,
              subject: input.subject,
              status: "sent",
            })
      const fromHeader = fromHeaderForThread(thread)
      const message = await insertOut({
        threadId: thread.id,
        direction: "out",
        fromAddr: fromHeader,
        toAddr: input.toAddr,
        subject: input.subject,
        body: input.body,
        kind: "digest",
      })
      const eventMeta: Record<string, unknown> = {}
      if (input.reportContext?.reportId !== undefined) {
        eventMeta.reportId = input.reportContext.reportId
      }
      if (input.geoid != null) eventMeta.geoid = input.geoid
      await deliverAndRecord({
        threadId: thread.id,
        messageId: message.id,
        fromHeader,
        toAddr: input.toAddr,
        subject: input.subject,
        body: input.body,
        eventMeta,
      })
      return freshThread(thread)
    },

    async compose(input: ComposeInput): Promise<MailThreadRecord> {
      const thread = await repo.createThread({ subject: input.subject, status: "sent" })
      const fromHeader = fromHeaderForThread(thread)
      const message = await insertOut({
        threadId: thread.id,
        direction: "out",
        fromAddr: fromHeader,
        toAddr: input.to,
        subject: input.subject,
        body: input.body,
        kind: "compose",
        ...(input.audit ? { audit: { ...input.audit, target: `mail:${thread.id}` } } : {}),
      })
      await deliverAndRecord({
        threadId: thread.id,
        messageId: message.id,
        fromHeader,
        toAddr: input.to,
        subject: input.subject,
        body: input.body,
      })
      return freshThread(thread)
    },

    async appendOutbound(threadId: string, input: AppendOutboundInput): Promise<MailThreadRecord> {
      const thread = await repo.getThreadRecord(threadId)
      if (!thread) {
        throw AppError.notFound("Mail thread not found")
      }
      const subject = input.subject ?? replySubject(thread.subject)
      const fromHeader = fromHeaderForThread(thread)
      const attachments = attachmentMetadata(input.attachments)
      const message = await insertOut({
        threadId: thread.id,
        direction: "out",
        fromAddr: fromHeader,
        toAddr: input.toAddr,
        subject,
        body: input.body,
        kind: input.kind ?? "reply",
        ...(input.html !== undefined ? { html: input.html } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(input.audit ? { audit: { ...input.audit, target: `mail:${thread.id}` } } : {}),
      })
      await deliverAndRecord({
        threadId: thread.id,
        messageId: message.id,
        fromHeader,
        toAddr: input.toAddr,
        subject,
        body: input.body,
        ...(input.html !== undefined ? { html: input.html } : {}),
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        ...(input.eventMeta !== undefined ? { eventMeta: input.eventMeta } : {}),
      })
      return freshThread(thread)
    },
  }
}

type OutboundMailContainer = {
  getDb(): DbHandle
  mailer: Mailer
  env: Pick<
    Env,
    | "MAIL_FROM_OUTREACH"
    | "MAIL_REPLY_DOMAIN"
    | "OCI_EMAIL_SMTP_TIMEOUT_MS"
    | "OUTBOUND_SEND_MIN_THROUGHPUT_BPS"
  >
}

export function makeContainerOutboundMailService(
  container: OutboundMailContainer,
  overrides?: { repo?: MailRepository; logger?: OutboundMailLogger },
): OutboundMailService {
  return makeOutboundMailService({
    repo: overrides?.repo ?? makeDrizzleMailRepository(container.getDb().sql),
    mailer: container.mailer,
    env: {
      MAIL_FROM_OUTREACH: container.env.MAIL_FROM_OUTREACH,
      MAIL_REPLY_DOMAIN: container.env.MAIL_REPLY_DOMAIN,
    },
    sendPhaseBudgetMs: phaseBudgetFor(container.env.OCI_EMAIL_SMTP_TIMEOUT_MS),
    sendMinThroughputBytesPerSec: container.env.OUTBOUND_SEND_MIN_THROUGHPUT_BPS,
    ...(overrides?.logger !== undefined ? { logger: overrides.logger } : {}),
  })
}

export function replySubject(subject: string | null): string {
  const base = subject ?? ""
  if (base.length === 0) return "Re:"
  return /^re:/i.test(base) ? base : `Re: ${base}`
}
