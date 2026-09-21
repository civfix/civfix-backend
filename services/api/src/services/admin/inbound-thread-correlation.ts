import { createHash } from "node:crypto"
import type { Container } from "../../di.js"
import type { ParsedMail } from "@civfix/shared/interfaces"
import type {
  MailMessageRecord,
  MailRepository,
  MailThreadRecord,
} from "./mail-repository.drizzle.js"
import { makeDrizzleAdminReportRepository } from "./admin-report-repository.drizzle.js"
import type { AdminReportRepository, ReporterNotifier } from "./admin-report-service.js"
import { JURISDICTION_REPLY_NOTE } from "./admin-report-status.js"
import { makeDrizzleCleanupRepository } from "../cleanup-repository.drizzle.js"
import type { CleanupRepository } from "../cleanup-service.js"
import { makeContainerReportChatEmitter } from "../report-chat-emitter.js"
import { domainOf, domainsAligned } from "../../adapters/inbound-mail.cf.js"

export { JURISDICTION_REPLY_NOTE }

export interface InboundEffectDeps {
  reportRepo?: AdminReportRepository
  cleanupRepo?: CleanupRepository
  notifications?: ReporterNotifier
}

export const EFFECTS_LEASE_MS = 10 * 60 * 1000

export const EFFECTS_STAGE_TIMELINE = 1
export const EFFECTS_STAGE_CHAT = 2
export const EFFECTS_STAGE_NOTIFIED = 3

export const JURISDICTION_REPLY_NOTIFICATION_BODY =
  "The city responded. A civfix operator is reviewing their message."

export function inboundEffectDeps(deps: {
  adminReportRepo?: AdminReportRepository
  cleanupRepo?: CleanupRepository
  notifications?: ReporterNotifier
} = {}): InboundEffectDeps {
  return {
    ...(deps.adminReportRepo !== undefined ? { reportRepo: deps.adminReportRepo } : {}),
    ...(deps.cleanupRepo !== undefined ? { cleanupRepo: deps.cleanupRepo } : {}),
    ...(deps.notifications !== undefined ? { notifications: deps.notifications } : {}),
  }
}

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
  injected: InboundEffectDeps,
  mailRepo: MailRepository,
  thread: MailThreadRecord,
  message: MailMessageRecord,
  now: () => Date = () => new Date(),
): Promise<void> {
  if (message.direction !== "in") return
  if (message.unaffiliated) return
  if (thread.reportId === null && thread.cleanupId === null) return
  const leaseBefore = new Date(now().getTime() - EFFECTS_LEASE_MS)
  const stage = await mailRepo.claimMessageEffects(message.id, { leaseBefore })
  if (stage === null) return
  try {
    if (thread.reportId !== null) {
      await onJurisdictionReply(container, injected, mailRepo, thread, message.id, stage)
    } else {
      await onEventReply(container, injected.cleanupRepo, mailRepo, thread, message, stage)
    }
    await mailRepo.markMessageEffectsApplied(message.id)
  } catch (err) {
    await mailRepo.releaseMessageEffects(message.id).catch(() => {})
    throw err
  }
}

export async function onJurisdictionReply(
  container: Container,
  injected: InboundEffectDeps,
  mailRepo: MailRepository,
  thread: MailThreadRecord,
  messageId: string,
  stage: number,
): Promise<void> {
  const reportId = thread.reportId
  if (reportId === null) return

  const reportRepo = injected.reportRepo ?? makeDrizzleAdminReportRepository(container.getDb().sql)
  const record = await reportRepo.getReport(reportId)
  if (!record) return

  const note = JURISDICTION_REPLY_NOTE

  if (stage < EFFECTS_STAGE_TIMELINE) {
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
    await mailRepo.setMessageEffectsStage(messageId, EFFECTS_STAGE_TIMELINE)
  }

  if (stage < EFFECTS_STAGE_CHAT) {
    const current = await reportRepo.getReport(reportId)
    await makeContainerReportChatEmitter(container).emit({
      reportId,
      status: current?.status ?? record.status,
      kind: "reply",
      note,
      body: null,
    })
    await mailRepo.setMessageEffectsStage(messageId, EFFECTS_STAGE_CHAT)
  }

  if (stage < EFFECTS_STAGE_NOTIFIED) {
    const reporterUserId = record.reporter?.id
    if (reporterUserId && reporterUserId !== "") {
      const notifications = injected.notifications ?? container.getNotificationService()
      await notifications.createNotification(reporterUserId, {
        type: "report_update",
        title: "Your report got a response",
        body: JURISDICTION_REPLY_NOTIFICATION_BODY,
        link: `/reports/${reportId}`,
      })
    }
    await mailRepo.setMessageEffectsStage(messageId, EFFECTS_STAGE_NOTIFIED)
  }

  await mailRepo.setThreadStatus(thread.id, "replied")
}

export async function onEventReply(
  container: Container,
  injectedCleanupRepo: CleanupRepository | undefined,
  mailRepo: MailRepository,
  thread: MailThreadRecord,
  message: MailMessageRecord,
  stage: number,
): Promise<void> {
  const cleanupId = thread.cleanupId
  if (cleanupId === null) return

  if (stage < EFFECTS_STAGE_TIMELINE) {
    const cleanupRepo = injectedCleanupRepo ?? makeDrizzleCleanupRepository(container.getDb().sql)
    const fullBody = (message.body ?? "").trim()
    const preview = replyPreview(fullBody)
    const note = preview.length > 0 ? `Jurisdiction replied — ${preview}` : "Jurisdiction replied"
    await cleanupRepo.appendCleanupTimeline(cleanupId, {
      kind: "city_reply",
      note: fullBody.length > 0 ? fullBody : note,
      actorId: null,
    })
    await mailRepo.setMessageEffectsStage(message.id, EFFECTS_STAGE_TIMELINE)
  }
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
