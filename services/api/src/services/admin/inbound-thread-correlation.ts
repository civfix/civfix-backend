
import { createHash } from "node:crypto"
import type { Container } from "../../di.js"
import type { ParsedMail } from "@civfix/shared/interfaces"
import type { MailRepository, MailThreadRecord } from "./mail-repository.drizzle.js"
import { makeDrizzleAdminReportRepository } from "./admin-report-repository.drizzle.js"
import type { AdminReportRepository } from "./admin-report-service.js"
import { makeDrizzleCleanupRepository } from "../cleanup-repository.drizzle.js"
import type { CleanupRepository } from "../cleanup-service.js"
import { makeContainerReportChatEmitter } from "../report-chat-emitter.js"

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

export async function onJurisdictionReply(
  container: Container,
  injectedReportRepo: AdminReportRepository | undefined,
  mailRepo: MailRepository,
  thread: MailThreadRecord,
  mail: ParsedMail,
): Promise<void> {
  const reportId = thread.reportId
  if (reportId === null) return
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

export function resolveMessageId(mail: ParsedMail): string {
  if (mail.messageId && mail.messageId.length > 0) return mail.messageId
  const basis = [
    mail.from?.address ?? "",
    mail.headers["date"] ?? "",
    mail.subject ?? "",
    String((mail.text ?? mail.html ?? "").length),
  ].join("|")
  return `derived:${createHash("sha256").update(basis).digest("hex")}`
}
