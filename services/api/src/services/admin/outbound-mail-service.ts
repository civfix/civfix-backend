
import { AppError } from "@civfix/shared"
import type { Mailer, OutboundAttachment } from "@civfix/shared/interfaces"
import type { Container } from "../../di.js"
import {
  makeDrizzleMailRepository,
  type MailAuditInput,
  type MailMessageRecord,
  type MailRepository,
  type MailThreadRecord,
} from "./mail-repository.drizzle.js"
import { domainOf } from "../../adapters/mail-text.js"

export interface OutboundMailEnv {
  MAIL_FROM_OUTREACH: string
  MAIL_REPLY_DOMAIN: string
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
  audit?: OutboundAudit
}

export interface SendReportInput {
  reportId: string
  geoid: string | null
  org?: string | null
  toAddr: string
  subject: string
  text: string
  html?: string
  attachments?: OutboundAttachment[]
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

export interface OutboundMailService {
  sendToCity(input: SendToCityInput): Promise<MailThreadRecord>
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
}

export function makeOutboundMailService(deps: OutboundMailServiceDeps): OutboundMailService {
  const { repo, mailer, env } = deps
  const logger: OutboundMailLogger = deps.logger ?? console

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
    attachments?: OutboundAttachment[]
    eventMeta?: Record<string, unknown>
  }): Promise<string> {
    const rfcMessageId = `<out-${args.messageId}@${domainOf(env.MAIL_FROM_OUTREACH)}>`
    const priorIds = await repo
      .priorOutboundMessageIds(args.threadId)
      .catch(() => [] as string[])
    const inReplyTo = priorIds.length > 0 ? priorIds[priorIds.length - 1] : undefined
    const references =
      priorIds.length > 10 ? [priorIds[0] as string, ...priorIds.slice(-9)] : priorIds
    let sent: { messageId: string }
    try {
      sent = await mailer.sendOutbound({
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
    } catch (err) {
      try {
        await repo.recordEvent({
          threadId: args.threadId,
          messageId: args.messageId,
          type: "failed",
          meta: {
            from: env.MAIL_FROM_OUTREACH,
            to: args.toAddr,
            error: err instanceof Error ? err.message : String(err),
            ...(args.eventMeta ?? {}),
          },
        })
      } catch (recordErr) {
        logger.warn(
          { err: recordErr, threadId: args.threadId, messageId: args.messageId },
          "outbound mail send failed AND recording the 'failed' event failed",
        )
      }
      throw err
    }
    try {
      await repo.setMessageMessageId(args.messageId, sent.messageId)
      await repo.recordEvent({
        threadId: args.threadId,
        messageId: args.messageId,
        type: "sent",
        meta: { from: env.MAIL_FROM_OUTREACH, to: args.toAddr, ...(args.eventMeta ?? {}) },
      })
    } catch (err) {
      logger.warn(
        { err, threadId: args.threadId, messageId: args.messageId },
        "outbound mail delivered but post-send write failed (Message-ID/'sent' may be missing)",
      )
    }
    return sent.messageId
  }

  async function insertOut(input: Parameters<MailRepository["insertMessage"]>[0]): Promise<MailMessageRecord> {
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

  return {
    async sendReportToJurisdiction(
      input: SendReportInput,
    ): Promise<{ thread: MailThreadRecord; messageId: string }> {
      const thread = await repo.findOrCreateReportThread(input.reportId, {
        jurisdictionGeoid: input.geoid,
        org: input.org ?? null,
        subject: input.subject,
        status: "sent",
      })
      const message = await insertOut({
        threadId: thread.id,
        direction: "out",
        fromAddr: env.MAIL_FROM_OUTREACH,
        toAddr: input.toAddr,
        subject: input.subject,
        body: input.text,
        ...(input.audit
          ? {
              audit: {
                ...input.audit,
                meta: { ...(input.audit.meta ?? {}), threadId: thread.id, to: input.toAddr },
              },
            }
          : {}),
      })
      const messageId = await deliverAndRecord({
        threadId: thread.id,
        messageId: message.id,
        fromHeader: fromHeaderForThread(thread),
        toAddr: input.toAddr,
        subject: input.subject,
        body: input.text,
        ...(input.html !== undefined ? { html: input.html } : {}),
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        eventMeta: { reportId: input.reportId, ...(input.geoid != null ? { geoid: input.geoid } : {}) },
      })
      if (thread.status === "bounced") {
        try {
          await repo.setThreadStatus(thread.id, "sent")
        } catch (err) {
          logger.warn(
            { err, threadId: thread.id },
            "report re-route delivered but clearing the thread's 'bounced' status failed",
          )
        }
      }
      return { thread: await freshThread(thread), messageId }
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
      const message = await insertOut({
        threadId: thread.id,
        direction: "out",
        fromAddr: env.MAIL_FROM_OUTREACH,
        toAddr: input.toAddr,
        subject: input.subject,
        body: input.text,
      })
      const messageId = await deliverAndRecord({
        threadId: thread.id,
        messageId: message.id,
        fromHeader: fromHeaderForThread(thread),
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
      const message = await insertOut({
        threadId: thread.id,
        direction: "out",
        fromAddr: env.MAIL_FROM_OUTREACH,
        toAddr: input.toAddr,
        subject: input.subject,
        body: input.body,
      })
      const eventMeta: Record<string, unknown> = {}
      if (input.reportContext?.reportId !== undefined) {
        eventMeta.reportId = input.reportContext.reportId
      }
      if (input.geoid != null) eventMeta.geoid = input.geoid
      await deliverAndRecord({
        threadId: thread.id,
        messageId: message.id,
        fromHeader: fromHeaderForThread(thread),
        toAddr: input.toAddr,
        subject: input.subject,
        body: input.body,
        eventMeta,
      })
      return freshThread(thread)
    },

    async compose(input: ComposeInput): Promise<MailThreadRecord> {
      const thread = await repo.createThread({ subject: input.subject, status: "sent" })
      const message = await insertOut({
        threadId: thread.id,
        direction: "out",
        fromAddr: env.MAIL_FROM_OUTREACH,
        toAddr: input.to,
        subject: input.subject,
        body: input.body,
        ...(input.audit ? { audit: { ...input.audit, target: `mail:${thread.id}` } } : {}),
      })
      await deliverAndRecord({
        threadId: thread.id,
        messageId: message.id,
        fromHeader: fromHeaderForThread(thread),
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
      const message = await insertOut({
        threadId: thread.id,
        direction: "out",
        fromAddr: env.MAIL_FROM_OUTREACH,
        toAddr: input.toAddr,
        subject,
        body: input.body,
        ...(input.audit ? { audit: { ...input.audit, target: `mail:${thread.id}` } } : {}),
      })
      await deliverAndRecord({
        threadId: thread.id,
        messageId: message.id,
        fromHeader: fromHeaderForThread(thread),
        toAddr: input.toAddr,
        subject,
        body: input.body,
      })
      return freshThread(thread)
    },
  }
}

export function makeContainerOutboundMailService(
  container: Container,
  overrides?: { repo?: MailRepository; logger?: OutboundMailLogger },
): OutboundMailService {
  return makeOutboundMailService({
    repo: overrides?.repo ?? makeDrizzleMailRepository(container.getDb().sql),
    mailer: container.mailer,
    env: {
      MAIL_FROM_OUTREACH: container.env.MAIL_FROM_OUTREACH,
      MAIL_REPLY_DOMAIN: container.env.MAIL_REPLY_DOMAIN,
    },
    ...(overrides?.logger !== undefined ? { logger: overrides.logger } : {}),
  })
}

function replySubject(subject: string | null): string {
  const base = subject ?? ""
  if (base.length === 0) return "Re:"
  return /^re:/i.test(base) ? base : `Re: ${base}`
}
