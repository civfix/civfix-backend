
import { createHash } from "node:crypto"
import type { Container } from "../../di.js"
import type { ParsedMail } from "@civfix/shared/interfaces"
import type { MailRepository, MailThreadRecord } from "./mail-repository.drizzle.js"
import { makeDrizzleAdminReportRepository } from "./admin-report-repository.drizzle.js"
import type { AdminReportRepository } from "./admin-report-service.js"
import { makeDrizzleCleanupRepository } from "../cleanup-repository.drizzle.js"
import type { CleanupRepository } from "../cleanup-service.js"
import { makeContainerReportChatEmitter } from "../report-chat-emitter.js"
import { domainOf, domainsAligned } from "../../adapters/inbound-mail.cf.js"

export async function findThreadByReferences(
  mailRepo: MailRepository,
  mail: ParsedMail,
): Promise<MailThreadRecord | null> {
  const ids: string[] = []
  if (mail.inReplyTo && mail.inReplyTo.length > 0) ids.push(mail.inReplyTo)
  for (const ref of parseMessageIdList(mail.headers["references"])) ids.push(ref)
  if (ids.length === 0) return null
  return mailRepo.findThreadByOutboundMessageIds(ids)
}

export const MESSAGE_ID_LIST_CAP = 20

export function parseMessageIdList(value: string | undefined): string[] {
  if (!value || value.length === 0) return []
  const out: string[] = []
  const re = /<[^>]+>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) {
    out.push(m[0])
    if (out.length >= MESSAGE_ID_LIST_CAP) return out
  }
  if (out.length === 0) {
    for (const token of value.split(/\s+/)) {
      const t = token.trim()
      if (t.length > 0 && t.includes("@")) {
        out.push(t)
        if (out.length >= MESSAGE_ID_LIST_CAP) break
      }
    }
  }
  return out
}

/**
 * SENDER GATE (M7). True when `mail.from` is domain-aligned with an address WE actually mailed on this
 * thread — i.e. the jurisdiction contact. The thread carries no contact column, so the authority is the
 * thread's own OUTBOUND messages: their `to` addresses are, by construction, the contacts civfix chose.
 *
 * A reply from any other domain is NOT a jurisdiction reply, no matter how it was threaded. Without this
 * check a forged message routed into a thread flipped the report to in_progress, published the sender's
 * text into the PUBLIC report chat as an official city reply, and pushed "Your report got a response"
 * to the reporter.
 *
 * FAIL CLOSED: a thread whose outbound recipients cannot be read (no outbound message yet, or a lookup
 * failure) yields `false` — the message is still filed, it just fires no side effects.
 */
export async function isJurisdictionSender(
  mailRepo: MailRepository,
  threadId: string,
  mail: ParsedMail,
): Promise<boolean> {
  const fromDomain = domainOf(mail.from?.address ?? null)
  if (fromDomain === null) return false
  let recipients: string[]
  try {
    recipients = await mailRepo.outboundRecipients(threadId)
  } catch {
    return false
  }
  for (const recipient of recipients) {
    const contactDomain = domainOf(recipient)
    if (contactDomain !== null && domainsAligned(fromDomain, contactDomain)) return true
  }
  return false
}

export async function onJurisdictionReply(
  container: Container,
  injectedReportRepo: AdminReportRepository | undefined,
  mailRepo: MailRepository,
  thread: MailThreadRecord,
  mail: ParsedMail,
): Promise<void> {
  const reportId = thread.reportId
  if (reportId === null) return

  // M7: everything below this line is an OFFICIAL-CITY-REPLY effect — a public status transition, a
  // public chat post attributed to the city, and a push to the reporter. Gate all of it on the sender
  // actually being the jurisdiction contact. A mismatch is Inbox-only: the message is already persisted
  // on the thread by the caller (routeThreaded), it simply drives no side effects.
  if (!(await isJurisdictionSender(mailRepo, thread.id, mail))) {
    return
  }

  const reportRepo = injectedReportRepo ?? makeDrizzleAdminReportRepository(container.getDb().sql)
  const record = await reportRepo.getReport(reportId)
  if (!record) return

  const fullBody = (mail.text ?? mail.html ?? "").trim()
  const preview = replyPreview(fullBody)
  const note = `Jurisdiction replied — ${preview}`
  const body = fullBody.length > 0 ? fullBody : null

  // The inbound reply either ADVANCES the report to in_progress (from published/acknowledged) or is a
  // non-transition system row at the report's CURRENT status. Track the effective status so the report-chat
  // system message carries the SAME status the timeline row got.
  const advances = record.status === "published" || record.status === "acknowledged"
  if (advances) {
    await reportRepo.setStatus(reportId, {
      status: "in_progress",
      note,
      actorId: null,
      kind: "reply",
      body,
    })
  } else {
    await reportRepo.appendSystemTimeline(reportId, { note, kind: "reply", body })
  }

  // D-D1: mirror the city reply into the report chat (best-effort; the emitter swallows its own errors).
  // No-op under fake-chat. `injectedReportRepo` present ⇒ an offline test path with no real container chat;
  // still safe (the emitter degrades to no-op when chat services are the fake variants).
  await makeContainerReportChatEmitter(container).emit({
    reportId,
    status: advances ? "in_progress" : record.status,
    kind: "reply",
    note,
    body,
  })

  const reporterUserId = record.reporter?.id
  if (reporterUserId && reporterUserId !== "") {
    await reportRepo.notifyReporter({
      reportId,
      reporterUserId,
      title: "Your report got a response",
      body: preview,
      link: `/reports/${reportId}`,
    })
  }

  await mailRepo.setThreadStatus(thread.id, "replied")
}

export async function onEventReply(
  container: Container,
  injectedCleanupRepo: CleanupRepository | undefined,
  mailRepo: MailRepository,
  thread: MailThreadRecord,
  mail: ParsedMail,
): Promise<void> {
  const cleanupId = thread.cleanupId
  if (cleanupId === null) return

  // M7: same gate as onJurisdictionReply. Everything below writes the sender's body into cleanup_timeline
  // as an OFFICIAL 'city_reply' the event's organizer + attendees read, so it must come from the contact
  // we actually mailed on this thread. A mismatch is Inbox-only: the message is already persisted on the
  // thread by the caller (routeThreaded), it simply drives no side effects.
  if (!(await isJurisdictionSender(mailRepo, thread.id, mail))) {
    return
  }

  const cleanupRepo = injectedCleanupRepo ?? makeDrizzleCleanupRepository(container.getDb().sql)
  const fullBody = (mail.text ?? mail.html ?? "").trim()
  const preview = replyPreview(fullBody)
  const note = preview.length > 0 ? `Jurisdiction replied — ${preview}` : "Jurisdiction replied"
  await cleanupRepo.appendCleanupTimeline(cleanupId, {
    kind: "city_reply",
    note: fullBody.length > 0 ? fullBody : note,
    actorId: null,
  })
  await mailRepo.setThreadStatus(thread.id, "replied")
}

export function replyPreview(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim()
  return collapsed.length > 140 ? `${collapsed.slice(0, 140)}…` : collapsed
}

/** How much body CONTENT the derived message-id hashes (bounded so a huge body stays cheap to digest). */
const DERIVED_ID_BODY_PREFIX_CHARS = 4096

/**
 * The message_id used for replay dedup: the header when present, else a hash of the message's identity.
 *
 * The hash covers a PREFIX OF THE BODY, not just its length: two distinct Message-ID-less messages from
 * one sender with the same subject and Date header collided on equal body lengths, and the second was
 * dropped as a replay.
 */
export function resolveMessageId(mail: ParsedMail): string {
  if (mail.messageId && mail.messageId.length > 0) return mail.messageId
  const body = mail.text ?? mail.html ?? ""
  const basis = [
    mail.from?.address ?? "",
    mail.headers["date"] ?? "",
    mail.subject ?? "",
    String(body.length),
    body.slice(0, DERIVED_ID_BODY_PREFIX_CHARS),
  ].join("|")
  return `derived:${createHash("sha256").update(basis).digest("hex")}`
}
