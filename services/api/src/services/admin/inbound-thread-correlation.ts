import { createHash } from "node:crypto"
import type { Container } from "../../di.js"
import type { ParsedMail } from "@civfix/shared/interfaces"
import type {
  MailMessageRecord,
  MailRepository,
  MailThreadRecord,
} from "./mail-repository.drizzle.js"
import { makeDrizzleAdminReportRepository } from "./admin-report-repository.drizzle.js"
import type { AdminReportRepository } from "./admin-report-service.js"
import { makeDrizzleCleanupRepository } from "../cleanup-repository.drizzle.js"
import type { CleanupRepository } from "../cleanup-service.js"
import { makeContainerReportChatEmitter } from "../report-chat-emitter.js"
import { domainOf, domainsAligned } from "../../adapters/inbound-mail.cf.js"

export const JURISDICTION_REPLY_NOTE = "The city responded to this report"

export const JURISDICTION_REPLY_NOTIFICATION_BODY =
  "The city responded. A civfix operator is reviewing their message."

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

export async function applyInboundEffects(
  container: Container,
  injectedReportRepo: AdminReportRepository | undefined,
  injectedCleanupRepo: CleanupRepository | undefined,
  mailRepo: MailRepository,
  thread: MailThreadRecord,
  message: MailMessageRecord,
): Promise<void> {
  if (message.direction !== "in") return
  if (message.unaffiliated) return
  if (thread.reportId === null && thread.cleanupId === null) return
  if (!(await mailRepo.claimMessageEffects(message.id))) return
  try {
    if (thread.reportId !== null) {
      await onJurisdictionReply(container, injectedReportRepo, mailRepo, thread)
    } else {
      await onEventReply(container, injectedCleanupRepo, mailRepo, thread, message)
    }
  } catch (err) {
    await mailRepo.releaseMessageEffects(message.id).catch(() => {})
    throw err
  }
}

export async function onJurisdictionReply(
  container: Container,
  injectedReportRepo: AdminReportRepository | undefined,
  mailRepo: MailRepository,
  thread: MailThreadRecord,
): Promise<void> {
  const reportId = thread.reportId
  if (reportId === null) return

  const reportRepo = injectedReportRepo ?? makeDrizzleAdminReportRepository(container.getDb().sql)
  const record = await reportRepo.getReport(reportId)
  if (!record) return

  const note = JURISDICTION_REPLY_NOTE
  const advances = record.status === "published" || record.status === "acknowledged"
  if (advances) {
    await reportRepo.setStatus(reportId, {
      status: "in_progress",
      note,
      actorId: null,
      kind: "reply",
      body: null,
    })
  } else {
    await reportRepo.appendSystemTimeline(reportId, { note, kind: "reply", body: null })
  }

  await makeContainerReportChatEmitter(container).emit({
    reportId,
    status: advances ? "in_progress" : record.status,
    kind: "reply",
    note,
    body: null,
  })

  const reporterUserId = record.reporter?.id
  if (reporterUserId && reporterUserId !== "") {
    await reportRepo.notifyReporter({
      reportId,
      reporterUserId,
      title: "Your report got a response",
      body: JURISDICTION_REPLY_NOTIFICATION_BODY,
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
  message: MailMessageRecord,
): Promise<void> {
  const cleanupId = thread.cleanupId
  if (cleanupId === null) return

  const cleanupRepo = injectedCleanupRepo ?? makeDrizzleCleanupRepository(container.getDb().sql)
  const fullBody = (message.body ?? "").trim()
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

const DERIVED_ID_BODY_PREFIX_CHARS = 4096

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
