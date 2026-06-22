/**
 * OutboundMailService: the thin "send mail + record it" service the admin reports/events + mail routers
 * call. It composes the MailRepository (persist the thread/message/event) with the Mailer seam (deliver),
 * fully unit-testable with the in-memory repo + FakeMailer. Four send paths (sendToCity,
 * sendReportToJurisdiction, compose, appendOutbound), all From MAIL_FROM_OUTREACH; each returns the
 * affected thread record (sendReportToJurisdiction also the Message-ID) so the caller can map it to a DTO.
 *
 * Delivery uses `Mailer.sendOutbound(email)` (the first-class envelope seam) which HONORS `from` +
 * `replyTo` and carries attachments + an explicit Message-ID (the two the old `sendTransactional` path
 * silently dropped in prod). The reply-to is minted reply+{threadToken}@{MAIL_REPLY_DOMAIN} so an inbound
 * reply threads back; the returned Message-ID is stored on the OUT row for In-Reply-To correlation.
 *
 * Audit (H4): the operator audit (mail.sent / mail.replied / mail.resent) is written in the SAME tx as the
 * message insert (repo.insertMessage's audit param), so a committed outbound message can never lack its
 * audit row. The deliverability mail_events 'sent' row is recorded separately.
 *
 * RELIABILITY: the post-send writes (store Message-ID, record 'sent') run AFTER delivery succeeded. They
 * are best-effort + logged — a failure there must NOT surface a 500 for an already-sent message (which an
 * operator would re-send, double-sending). The trade-off: a lost Message-ID/'sent' row weakens
 * reply/bounce correlation + deliverability stats for that one message, which is preferable to a duplicate
 * send. The ideal fix is a single repo `recordSent` tx; that needs a MailRepository change (see U16).
 */

import { AppError } from "@civfix/shared"
import type { Mailer, OutboundAttachment } from "@civfix/shared/interfaces"
import type { MailAuditInput, MailRepository, MailThreadRecord } from "./mail-repository.drizzle.js"
import { domainOf } from "../../adapters/mail-text.js"

/** The env slice the service needs (the outbound From + the reply domain for threading). */
export interface OutboundMailEnv {
  MAIL_FROM_OUTREACH: string
  MAIL_REPLY_DOMAIN: string
}

/** Minimal logger seam for the best-effort post-send warnings (defaults to console). */
export interface OutboundMailLogger {
  warn(obj: unknown, msg?: string): void
}

/** Optional report context the reports follow-up can thread into the message (for the operator trail). */
export interface ReportContext {
  reportId?: string
  category?: string
  place?: string
}

/** sendToCity input: route to a jurisdiction's contact and append/record the outbound message. */
export interface SendToCityInput {
  /** The jurisdiction this outreach concerns (sets the thread's geoid + org label). */
  geoid?: string | null
  /** The municipal contact address to deliver to. */
  toAddr: string
  subject: string
  body: string
  /** Optional originating-report context (recorded on the 'sent' event meta). */
  reportContext?: ReportContext
  /** Optional display label for the jurisdiction (the thread `org`). */
  org?: string | null
}

/** An operator audit to write in-tx with the send (H4); the service fills the `mail:{threadId}` target. */
export type OutboundAudit = Omit<MailAuditInput, "target">

/** compose input: a brand-new outbound thread (the Compose modal). */
export interface ComposeInput {
  to: string
  subject: string
  body: string
  /** Optional operator audit (mail.sent) written in-tx with the first message (H4). */
  audit?: OutboundAudit
}

/** appendOutbound input: append an OUT message to an existing thread (the Mail reply). */
export interface AppendOutboundInput {
  body: string
  toAddr: string
  /** Optional subject override; defaults to the thread's subject (prefixed "Re:" when absent here). */
  subject?: string
  /** Optional operator audit (mail.replied / mail.resent) written in-tx with the message (H4). */
  audit?: OutboundAudit
}

/**
 * sendReportToJurisdiction input: route THIS report's full packet to a jurisdiction contact on a
 * per-report thread (so the city's reply auto-routes back onto the report). Carries the rendered
 * subject/body + binary photo attachments; the service owns the thread, reply token, and Message-ID.
 */
export interface SendReportInput {
  reportId: string
  /** The report's jurisdiction GEOID (sets the thread's geoid + the 'sent' event meta), or null. */
  geoid: string | null
  /** Display label for the jurisdiction (the thread `org`). */
  org?: string | null
  /** The municipal contact address to deliver to (resolved contact or the per-send override). */
  toAddr: string
  subject: string
  text: string
  html?: string
  /** Binary photo attachments (already loaded + capped by the caller). */
  attachments?: OutboundAttachment[]
}

/**
 * sendEventToJurisdiction input: route an event's resource-request packet to a jurisdiction contact on a
 * per-EVENT thread (so the city's reply auto-routes back onto the cleanup). The service owns the thread,
 * the event+ reply token, and the Message-ID.
 */
export interface SendEventInput {
  cleanupId: string
  /** The cleanup's jurisdiction GEOID (sets the thread's geoid + the 'sent' event meta), or null. */
  geoid: string | null
  /** Display label for the jurisdiction (the thread `org`). */
  org?: string | null
  /** The municipal contact address to deliver to. */
  toAddr: string
  subject: string
  text: string
  html?: string
}

/** The OutboundMailService surface the reports/events + mail routers import. */
export interface OutboundMailService {
  /** Reports/events "send follow-up to city": thread by jurisdiction, append OUT, deliver, record. */
  sendToCity(input: SendToCityInput): Promise<MailThreadRecord>
  /**
   * Approve & send THIS report to its jurisdiction: a per-report thread (find-or-create by report_id),
   * an OUT message with attachments + a reply token + a stored Message-ID, and a 'sent' event. Returns
   * the fresh thread + the Message-ID used (for reply/bounce correlation).
   */
  sendReportToJurisdiction(
    input: SendReportInput,
  ): Promise<{ thread: MailThreadRecord; messageId: string }>
  /**
   * Send THIS event's resource request to its jurisdiction: a per-event thread (find-or-create by
   * cleanup_id), an OUT message with an event+ reply token + a stored Message-ID, and a 'sent' event.
   * Returns the fresh thread + the Message-ID (for reply correlation onto the cleanup timeline).
   */
  sendEventToJurisdiction(
    input: SendEventInput,
  ): Promise<{ thread: MailThreadRecord; messageId: string }>
  /** Mail Compose modal: new outbound thread + first message + deliver. */
  compose(input: ComposeInput): Promise<MailThreadRecord>
  /** Mail reply: append an OUT message to an existing thread + deliver. */
  appendOutbound(threadId: string, input: AppendOutboundInput): Promise<MailThreadRecord>
  /** Mint the reply+{token}@{MAIL_REPLY_DOMAIN} address used for inbound threading. */
  mintReplyAddress(threadToken: string): string
}

export interface OutboundMailServiceDeps {
  repo: MailRepository
  mailer: Mailer
  env: OutboundMailEnv
  /** Optional logger for the best-effort post-send warnings (defaults to console). */
  logger?: OutboundMailLogger
}

/** Construct the OutboundMailService. Pure wiring over the deps; no infra handles, no container. */
export function makeOutboundMailService(deps: OutboundMailServiceDeps): OutboundMailService {
  const { repo, mailer, env } = deps
  const logger: OutboundMailLogger = deps.logger ?? console

  /** reply+{token}@{MAIL_REPLY_DOMAIN}; the inbound webhook parses {token} back to the thread. */
  function mintReplyAddress(threadToken: string): string {
    return `reply+${threadToken}@${env.MAIL_REPLY_DOMAIN}`
  }

  /** report+{token}@{MAIL_REPLY_DOMAIN}: the per-report Reply-To (D10); same token, typed local-part. */
  function mintReportReply(threadToken: string): string {
    return `report+${threadToken}@${env.MAIL_REPLY_DOMAIN}`
  }

  /** event+{token}@{MAIL_REPLY_DOMAIN}: the per-event Reply-To (D10); same token, typed local-part. */
  function mintEventReply(threadToken: string): string {
    return `event+${threadToken}@${env.MAIL_REPLY_DOMAIN}`
  }

  /**
   * Deliver one outbound message via `sendOutbound`, store the returned Message-ID on the OUT row, then
   * record the mail_events 'sent' row. Delivery happens BEFORE the post-send writes so a Mailer error
   * surfaces to the caller without a misleading 'sent' event. The post-send writes are best-effort +
   * logged: once delivery succeeded the message IS out, so a write failure must not 500 the caller into a
   * duplicate re-send. The OUT Message-ID is `<out-{id}@{fromDomain}>` for In-Reply-To/References
   * correlation.
   */
  async function deliverAndRecord(args: {
    threadId: string
    messageId: string
    threadToken: string
    toAddr: string
    subject: string
    body: string
    html?: string
    /** The Reply-To address; defaults to reply+{token}@ (digest/compose). Per-report/event pass report+/event+. */
    replyAddress?: string
    attachments?: OutboundAttachment[]
    eventMeta?: Record<string, unknown>
  }): Promise<string> {
    const rfcMessageId = `<out-${args.messageId}@${domainOf(env.MAIL_FROM_OUTREACH)}>`
    // D14: thread the follow-up to the city's client by echoing the thread's prior OUT Message-IDs as
    // In-Reply-To (the latest) + References (the chain). The FIRST message on a thread has no prior ids,
    // so both are omitted; subsequent sends carry them. Best-effort: a read failure just drops threading.
    const priorIds = await repo
      .priorOutboundMessageIds(args.threadId)
      .catch(() => [] as string[])
    const inReplyTo = priorIds.length > 0 ? priorIds[priorIds.length - 1] : undefined
    let sent: { messageId: string }
    try {
      sent = await mailer.sendOutbound({
        from: env.MAIL_FROM_OUTREACH,
        to: args.toAddr,
        replyTo: args.replyAddress ?? mintReplyAddress(args.threadToken),
        subject: args.subject,
        text: args.body,
        ...(args.html !== undefined ? { html: args.html } : {}),
        messageId: rfcMessageId,
        ...(inReplyTo !== undefined ? { inReplyTo } : {}),
        ...(priorIds.length > 0 ? { references: priorIds } : {}),
        ...(args.attachments !== undefined ? { attachments: args.attachments } : {}),
      })
    } catch (err) {
      // D17: a send rejection (a now-classified 409 for an unapproved sender, or a transient 500) leaves no
      // 'sent' row; record a 'failed' mail_events row so the admin Mail surface + deliverability trail see
      // the lost send, then re-throw so the route still surfaces the error to the operator. The failure
      // record is itself best-effort + logged — it must not mask the original send error.
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

  /** Re-read a thread after a write so the returned record reflects last_message_at; falls back + logs on a transient null. */
  async function freshThread(thread: MailThreadRecord): Promise<MailThreadRecord> {
    const fresh = await repo.getThreadRecord(thread.id)
    if (fresh === null) {
      logger.warn({ threadId: thread.id }, "outbound mail: thread re-read returned null; using stale record")
    }
    return fresh ?? thread
  }

  return {
    mintReplyAddress,

    async sendReportToJurisdiction(
      input: SendReportInput,
    ): Promise<{ thread: MailThreadRecord; messageId: string }> {
      // Per-report thread: find-or-create by report_id (with a minted reply token) so the city's reply
      // auto-routes back onto this report. The thread carries the report's geoid + org label.
      const thread = await repo.findOrCreateReportThread(input.reportId, {
        jurisdictionGeoid: input.geoid,
        org: input.org ?? null,
        subject: input.subject,
        status: "sent",
      })
      const message = await repo.insertMessage({
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
        threadToken: thread.threadToken,
        toAddr: input.toAddr,
        subject: input.subject,
        body: input.text,
        // D10: the per-report Reply-To is report+{token}@ (not the digest reply+). Same token.
        replyAddress: mintReportReply(thread.threadToken),
        ...(input.html !== undefined ? { html: input.html } : {}),
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        eventMeta: { reportId: input.reportId, ...(input.geoid != null ? { geoid: input.geoid } : {}) },
      })
      return { thread: await freshThread(thread), messageId }
    },

    async sendEventToJurisdiction(
      input: SendEventInput,
    ): Promise<{ thread: MailThreadRecord; messageId: string }> {
      // Per-EVENT thread: find-or-create by cleanup_id (with a minted reply token) so the city's reply
      // auto-routes back onto the event (onEventReply -> cleanup_timeline). From = the approved outreach
      // sender (M7); Reply-To = event+{token}@ (OCI honors from + replyTo separately).
      const thread = await repo.findOrCreateEventThread(input.cleanupId, {
        jurisdictionGeoid: input.geoid,
        org: input.org ?? null,
        subject: input.subject,
        status: "sent",
      })
      const message = await repo.insertMessage({
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
        threadToken: thread.threadToken,
        toAddr: input.toAddr,
        subject: input.subject,
        body: input.text,
        replyAddress: mintEventReply(thread.threadToken),
        ...(input.html !== undefined ? { html: input.html } : {}),
        eventMeta: {
          cleanupId: input.cleanupId,
          ...(input.geoid != null ? { geoid: input.geoid } : {}),
        },
      })
      return { thread: await freshThread(thread), messageId }
    },

    async sendToCity(input: SendToCityInput): Promise<MailThreadRecord> {
      // A jurisdiction's digest outreach is ONE rolling thread per geoid (newest non-report thread,
      // minted token) so repeated follow-ups append to the same conversation; the old `geo-{geoid}` token
      // scheme is gone (it failed the real inbound reply-token regex). Non-jurisdiction sends (no geoid)
      // get a fresh thread each time (there is no natural conversation to append to).
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
      const message = await repo.insertMessage({
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
        threadToken: thread.threadToken,
        toAddr: input.toAddr,
        subject: input.subject,
        body: input.body,
        eventMeta,
      })
      return freshThread(thread)
    },

    async compose(input: ComposeInput): Promise<MailThreadRecord> {
      const thread = await repo.createThread({ subject: input.subject, status: "sent" })
      const message = await repo.insertMessage({
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
        threadToken: thread.threadToken,
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
      const message = await repo.insertMessage({
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
        threadToken: thread.threadToken,
        toAddr: input.toAddr,
        subject,
        body: input.body,
      })
      return freshThread(thread)
    },
  }
}

/** Derive a reply subject from the thread subject ("Re: ..." once, not "Re: Re: ..."). */
function replySubject(subject: string | null): string {
  const base = subject ?? ""
  if (base.length === 0) return "Re:"
  return /^re:/i.test(base) ? base : `Re: ${base}`
}
