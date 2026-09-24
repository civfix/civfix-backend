import { createHash } from "node:crypto"
import type { Container } from "../../di.js"
import type { ParsedMail } from "@civfix/shared/interfaces"
import type {
  MailAuditInput,
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
import type { ReportChatSystemEmitter } from "../report-timeline-event.js"
import { MESSAGE_BODY_MAX, segmentGraphemes } from "@civfix/shared"
import {
  DEFAULT_REPLY_DOMAIN,
  domainOf,
  domainsAligned,
  replyAddressToken,
} from "../../adapters/inbound-mail.cf.js"

export { JURISDICTION_REPLY_NOTE }

export interface InboundLogger {
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export interface InboundEffectDeps {
  reportRepo?: AdminReportRepository
  cleanupRepo?: CleanupRepository
  notifications?: ReporterNotifier
  chatEmitter?: ReportChatSystemEmitter
  logger?: InboundLogger
}

export const EFFECTS_LEASE_MS = 10 * 60 * 1000

export const EFFECTS_STAGE_TIMELINE = 1
export const EFFECTS_STAGE_CHAT = 2
export const EFFECTS_STAGE_NOTIFIED = 3
export const EFFECTS_STAGE_SETTLED = 4

export const JURISDICTION_REPLY_NOTIFICATION_BODY =
  "The city responded. See their reply in the report chat."

export function inboundEffectDeps(
  deps: {
    adminReportRepo?: AdminReportRepository
    cleanupRepo?: CleanupRepository
    notifications?: ReporterNotifier
    chatEmitter?: ReportChatSystemEmitter
    logger?: InboundLogger
  } = {},
): InboundEffectDeps {
  return {
    ...(deps.adminReportRepo !== undefined ? { reportRepo: deps.adminReportRepo } : {}),
    ...(deps.cleanupRepo !== undefined ? { cleanupRepo: deps.cleanupRepo } : {}),
    ...(deps.notifications !== undefined ? { notifications: deps.notifications } : {}),
    ...(deps.chatEmitter !== undefined ? { chatEmitter: deps.chatEmitter } : {}),
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  }
}

const QUOTED_ATTRIBUTION_RE =
  /^(?:On\s.+\swrote|El\s.+\sescribió|Am\s.+\sschrieb\s[^:]+|Le\s.+\sa\sécrit\s?|\d{4}(?:년|\.)\s.+작성):$/
const ATTRIBUTION_MAX_CHARS = 400
const ATTRIBUTION_MAX_LINES = 3
const TRAILING_SEPARATOR_RE = /^[_-]{3,}$/
const OUTBOUND_MESSAGE_ID_PATTERN = "out-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}@"
const QUOTED_MESSAGE_SEPARATOR_RE = /^-{2,}\s*(?:Original|Forwarded) Message\s*-{2,}$/i
const OUTLOOK_HEADER_FROM_RE = /^From:\s.+$/
const OUTLOOK_HEADER_FOLLOW_RE = /^(?:Sent|Date|To):\s/
const OUTLOOK_HEADER_LOOKAHEAD = 2

function hasReplyTextBefore(lines: string[], index: number): boolean {
  for (let i = 0; i < index; i++) {
    const line = lines[i]!.trim()
    if (line !== "" && !line.startsWith(">")) return true
  }
  return false
}

function isQuotedAttributionAt(lines: string[], index: number, nested = false): boolean {
  let candidate = ""
  for (let n = 0; n < ATTRIBUTION_MAX_LINES; n++) {
    const next = lines[index + n]?.trim()
    if (next === undefined || next === "") return false
    if (n > 0 && !nested && isQuotedAttributionAt(lines, index + n, true)) return false
    candidate = n === 0 ? next : `${candidate} ${next}`
    if (candidate.length > ATTRIBUTION_MAX_CHARS) return false
    if ((n === 0 || candidate.includes("@")) && QUOTED_ATTRIBUTION_RE.test(candidate)) return true
  }
  return false
}

function ownMailIdentifierRe(replyDomain: string): RegExp {
  const domain = replyDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const tokenAddress = `(?:reply|report|event)[-+][a-z0-9]{8,40}@${domain}`
  return new RegExp(`${tokenAddress}|${OUTBOUND_MESSAGE_ID_PATTERN}`, "i")
}

function isQuotedHistoryStart(lines: string[], index: number): boolean {
  const line = lines[index]!.trim()
  if (isQuotedAttributionAt(lines, index)) return true
  if (QUOTED_MESSAGE_SEPARATOR_RE.test(line)) return true
  if (!OUTLOOK_HEADER_FROM_RE.test(line)) return false
  if (!hasReplyTextBefore(lines, index)) return false
  for (let ahead = 1; ahead <= OUTLOOK_HEADER_LOOKAHEAD; ahead++) {
    const follow = lines[index + ahead]
    if (follow === undefined) return false
    if (OUTLOOK_HEADER_FOLLOW_RE.test(follow.trim())) return true
  }
  return false
}

export function stripQuotedHistory(raw: string, replyDomain = DEFAULT_REPLY_DOMAIN): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n")
  const ownIdentifier = ownMailIdentifierRe(replyDomain)
  let end = lines.findIndex((line, i) => ownIdentifier.test(line) || isQuotedHistoryStart(lines, i))
  if (end === -1) end = lines.length
  while (end > 0) {
    const line = lines[end - 1]!.trim()
    if (line !== "" && !line.startsWith(">") && !TRAILING_SEPARATOR_RE.test(line)) break
    end -= 1
  }
  return lines.slice(0, end).join("\n").trim()
}

export function clipToMessageBody(text: string, max: number = MESSAGE_BODY_MAX): string {
  if (text.length <= max) return text
  let kept = ""
  for (const cluster of segmentGraphemes(text)) {
    if (kept.length + cluster.length > max) break
    kept += cluster
  }
  return kept
}

export function cityReplyChatBody(
  raw: string | null | undefined,
  replyDomain?: string,
): string | null {
  const clipped = clipToMessageBody(stripQuotedHistory(raw ?? "", replyDomain))
  return clipped === "" ? null : clipped
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

const OUTBOUND_MESSAGE_ID_RE = new RegExp(`^<${OUTBOUND_MESSAGE_ID_PATTERN}([^@>]+)>$`, "i")

export function isSelfOriginated(
  container: Container,
  mail: ParsedMail,
  messageId: string,
): boolean {
  const env = container.env as { MAIL_FROM_OUTREACH?: string; MAIL_REPLY_DOMAIN?: string }
  const outboundIdDomain = OUTBOUND_MESSAGE_ID_RE.exec(messageId)?.[1]?.toLowerCase()
  const outreachDomain = domainOf(env.MAIL_FROM_OUTREACH ?? null)
  if (outboundIdDomain !== undefined && outboundIdDomain === outreachDomain) return true
  const fromAddress = mail.from?.address
  if (fromAddress === undefined || env.MAIL_REPLY_DOMAIN === undefined) return false
  return replyAddressToken(fromAddress, env.MAIL_REPLY_DOMAIN) !== null
}

export async function isJurisdictionSender(
  mailRepo: MailRepository,
  threadId: string,
  mail: ParsedMail,
): Promise<boolean> {
  const fromDomain = domainOf(mail.from?.address ?? null)
  if (fromDomain === null) return false
  const recipients = await mailRepo.outboundRecipients(threadId)
  for (const recipient of recipients) {
    const contactDomain = domainOf(recipient)
    if (contactDomain !== null && domainsAligned(fromDomain, contactDomain)) return true
  }
  return false
}

export interface ApplyEffectsOptions {
  now?: () => Date
  publishedBy?: MailAuditInput
}

export async function applyInboundEffects(
  container: Container,
  injected: InboundEffectDeps,
  mailRepo: MailRepository,
  thread: MailThreadRecord,
  message: MailMessageRecord,
  opts: ApplyEffectsOptions = {},
): Promise<void> {
  if (message.direction !== "in") return
  if (message.unaffiliated) return
  if (thread.reportId === null && thread.cleanupId === null) return
  const now = opts.now ?? (() => new Date())
  const leaseBefore = new Date(now().getTime() - EFFECTS_LEASE_MS)
  const stage = await mailRepo.claimMessageEffects(message.id, { leaseBefore })
  if (stage === null) return
  try {
    if (thread.reportId !== null) {
      await onJurisdictionReply(container, injected, mailRepo, thread, message, stage)
    } else {
      await onEventReply(container, injected.cleanupRepo, mailRepo, thread, message, stage)
    }
    await mailRepo.markMessageEffectsApplied(message.id, opts.publishedBy)
  } catch (err) {
    await mailRepo.releaseMessageEffects(message.id).catch((releaseErr: unknown) => {
      injected.logger?.warn(
        { err: String(releaseErr), messageId: message.id },
        "inbound: effects claim release failed (the lease expires on its own)",
      )
    })
    throw err
  }
}

export async function onJurisdictionReply(
  container: Container,
  injected: InboundEffectDeps,
  mailRepo: MailRepository,
  thread: MailThreadRecord,
  message: MailMessageRecord,
  stage: number,
): Promise<void> {
  const reportId = thread.reportId
  if (reportId === null) return
  const messageId = message.id

  const reportRepo = injected.reportRepo ?? makeDrizzleAdminReportRepository(container.getDb().sql)
  const record = await reportRepo.getReport(reportId)
  if (!record) return

  const note = JURISDICTION_REPLY_NOTE
  const chatBody = cityReplyChatBody(message.body, container.env.MAIL_REPLY_DOMAIN)

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
    const emitter =
      injected.chatEmitter ??
      makeContainerReportChatEmitter(container, injected.logger, { propagateInsertFailure: true })
    await emitter.emit({
      reportId,
      status: current?.status ?? record.status,
      kind: "reply",
      note,
      body: chatBody,
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

  if (stage < EFFECTS_STAGE_SETTLED) {
    const emptied = chatBody === null && (message.body ?? "").trim() !== ""
    await mailRepo.settleRepliedThread({
      threadId: thread.id,
      messageId,
      stage: EFFECTS_STAGE_SETTLED,
      ...(emptied
        ? {
            flag: {
              actorId: null,
              action: "mail.reply_published_without_text",
              target: `mail:${thread.id}`,
              meta: { messageId, reportId },
            },
          }
        : {}),
    })
  }
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
  if (stage < EFFECTS_STAGE_SETTLED) {
    await mailRepo.settleRepliedThread({
      threadId: thread.id,
      messageId: message.id,
      stage: EFFECTS_STAGE_SETTLED,
    })
  }
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
