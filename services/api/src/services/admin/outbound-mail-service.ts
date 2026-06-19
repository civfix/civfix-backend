/**
 * OutboundMailService (Phase 2): the thin "send mail + record it" service the admin reports/events and
 * mail routers call. It composes the MailRepository (persist the thread/message/event) with the Mailer
 * seam (actually deliver), and nothing else - no Fastify, no DI container - so it is fully unit-testable
 * with the in-memory repo + FakeMailer.
 *
 * Four send paths, all From MAIL_FROM_OUTREACH (outreach@civfix.org):
 *   - sendToCity   the reports/events "send follow-up to city": find-or-create the jurisdiction's digest
 *                  thread (by geoid), append an OUT message, deliver, record a 'sent' event.
 *   - sendReportToJurisdiction  Approve & send THIS report: a per-report thread (by report_id) so the
 *                  city's reply auto-routes back onto the report, with photo attachments + a stored
 *                  Message-ID. Returns the thread + the Message-ID used.
 *   - compose      the Mail Compose modal: a brand-new outbound thread + first OUT message + deliver.
 *   - appendOutbound the Mail reply: append an OUT message to an existing thread + deliver.
 * Each returns the affected thread record (sendReportToJurisdiction also the Message-ID) so the caller
 * can map it to a DTO (via getThread).
 *
 * Delivery uses `Mailer.sendOutbound(email)` - the first-class envelope seam - which HONORS the `from`
 * (MAIL_FROM_OUTREACH) and `replyTo` and carries binary attachments + an explicit Message-ID (the two
 * the old `sendTransactional` path silently dropped in production). The reply-to address is minted as
 * reply+{threadToken}@{MAIL_REPLY_DOMAIN} so an inbound reply threads back (the inbound webhook, owned by
 * the mail agent, parses that token); the returned Message-ID is stored on the OUT row for In-Reply-To
 * correlation. The FakeMailer captures the full envelope for assertions.
 *
 * Audit note (H4): the operator audit (mail.sent / mail.replied / mail.resent) is written IN THE SAME
 * transaction as the message insert (repo.insertMessage's audit param), so a committed outbound message
 * can never lack its audit row. The caller (mail-service) passes the operator userId + action; this
 * service fills the `mail:{threadId}` target (it owns the thread id, including for a freshly composed
 * thread). The deliverability mail_events 'sent' row is recorded separately as before.
 */

import type { Mailer, OutboundAttachment } from "@civfix/shared/interfaces"
import type { MailAuditInput, MailRepository, MailThreadRecord } from "./mail-repository.drizzle.js"

/** The env slice the service needs (the outbound From + the reply domain for threading). */
export interface OutboundMailEnv {
  MAIL_FROM_OUTREACH: string
  MAIL_REPLY_DOMAIN: string
}

/**
 * Legacy template name for operator-originated outbound mail. Delivery now goes through the first-class
 * `Mailer.sendOutbound` envelope (no template), so this is retained only for the existing tests'
 * import surface; it is no longer passed to the Mailer.
 */
export const OUTBOUND_MAIL_TEMPLATE = "admin_outbound"

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
}

/**
 * Construct the OutboundMailService. Pure wiring over the three deps; no infra handles, no container.
 */
export function makeOutboundMailService(deps: OutboundMailServiceDeps): OutboundMailService {
  const { repo, mailer, env } = deps

  /** reply+{token}@{MAIL_REPLY_DOMAIN}; the inbound webhook parses {token} back to the thread. */
  function mintReplyAddress(threadToken: string): string {
    return `reply+${threadToken}@${env.MAIL_REPLY_DOMAIN}`
  }

  /** The sending domain (after '@' of MAIL_FROM_OUTREACH), used to mint the OUT Message-ID. */
  function fromDomain(): string {
    const at = env.MAIL_FROM_OUTREACH.lastIndexOf("@")
    const domain = at >= 0 ? env.MAIL_FROM_OUTREACH.slice(at + 1).trim() : ""
    return domain.length > 0 ? domain : "civfix.org"
  }

  /**
   * Deliver one outbound message via the first-class `sendOutbound` seam, store the returned Message-ID
   * on the OUT row, then record the mail_events 'sent' row. Delivery happens BEFORE the event is recorded
   * so a send failure (a thrown Mailer error) surfaces to the caller without leaving a misleading 'sent'
   * event. The From is MAIL_FROM_OUTREACH and the reply-to is the thread's minted address (so the city's
   * reply threads back via the inbound pipeline). The OUT Message-ID is derived from the message row id
   * (`<out-{id}@{fromDomain}>`) so an eventual reply/bounce can correlate by In-Reply-To/References.
   */
  async function deliverAndRecord(args: {
    threadId: string
    messageId: string
    threadToken: string
    toAddr: string
    subject: string
    body: string
    html?: string
    inReplyTo?: string
    attachments?: OutboundAttachment[]
    eventMeta?: Record<string, unknown>
  }): Promise<string> {
    const rfcMessageId = `<out-${args.messageId}@${fromDomain()}>`
    const sent = await mailer.sendOutbound({
      from: env.MAIL_FROM_OUTREACH,
      to: args.toAddr,
      replyTo: mintReplyAddress(args.threadToken),
      subject: args.subject,
      text: args.body,
      ...(args.html !== undefined ? { html: args.html } : {}),
      messageId: rfcMessageId,
      ...(args.inReplyTo !== undefined ? { inReplyTo: args.inReplyTo } : {}),
      ...(args.attachments !== undefined ? { attachments: args.attachments } : {}),
    })
    // Persist the Message-ID actually used on the OUT row (so a later reply/bounce correlates).
    await repo.setMessageMessageId(args.messageId, sent.messageId)
    await repo.recordEvent({
      threadId: args.threadId,
      messageId: args.messageId,
      type: "sent",
      meta: { from: env.MAIL_FROM_OUTREACH, to: args.toAddr, ...(args.eventMeta ?? {}) },
    })
    return sent.messageId
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
        ...(input.html !== undefined ? { html: input.html } : {}),
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        eventMeta: { reportId: input.reportId, ...(input.geoid != null ? { geoid: input.geoid } : {}) },
      })
      // Re-read so the returned record reflects the post-insert last_message_at.
      const fresh = await repo.getThreadRecord(thread.id)
      return { thread: fresh ?? thread, messageId }
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
      // Re-read so the returned record reflects the post-insert last_message_at.
      const fresh = await repo.getThreadRecord(thread.id)
      return fresh ?? thread
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
      const fresh = await repo.getThreadRecord(thread.id)
      return fresh ?? thread
    },

    async appendOutbound(threadId: string, input: AppendOutboundInput): Promise<MailThreadRecord> {
      const thread = await repo.getThreadRecord(threadId)
      if (!thread) {
        throw new Error(`appendOutbound: thread ${threadId} not found`)
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
      const fresh = await repo.getThreadRecord(thread.id)
      return fresh ?? thread
    },
  }
}

/** Derive a reply subject from the thread subject ("Re: ..." once, not "Re: Re: ..."). */
function replySubject(subject: string | null): string {
  const base = subject ?? ""
  if (base.length === 0) return "Re:"
  return /^re:/i.test(base) ? base : `Re: ${base}`
}
