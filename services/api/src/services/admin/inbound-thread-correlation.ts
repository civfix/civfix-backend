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
import type { ReportChatSystemEmitter } from "../report-timeline-event.js"
import { MESSAGE_BODY_MAX, segmentGraphemes } from "@civfix/shared"
import { sha256HexSync } from "../../lib/hash.js"
import {
  DEFAULT_REPLY_DOMAIN,
  domainOf,
  domainsAligned,
  organizationalDomain,
  replyAddressToken,
} from "../../adapters/inbound-mail.cf.js"
import { CONSUMER_MAIL_DOMAINS } from "./inbound-bounce.js"

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

const EVENT_REPLY_FALLBACK_NOTE = "Jurisdiction replied"

const EFFECTS_STAGE_TIMELINE = 1
const EFFECTS_STAGE_CHAT = 2
const EFFECTS_STAGE_NOTIFIED = 3

const JURISDICTION_REPLY_NOTIFICATION_TITLE = "Your report got a response"

export const JURISDICTION_REPLY_NOTIFICATION_BODY =
  "The city responded. See their reply in the report chat."

const BRACKETED_MESSAGE_ID_RE = /<[^>]+>/g

const DERIVED_ID_BODY_PREFIX_CHARS = 4096
const DERIVED_ID_PREFIX = "derived:"

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
const OUTLOOK_ORIGINAL_MESSAGE_RE = /^-{2,}\s*Original Message\s*-{2,}$/i
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
  if (OUTLOOK_ORIGINAL_MESSAGE_RE.test(line)) return true
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

function clipToMessageBody(text: string, max: number = MESSAGE_BODY_MAX): string {
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
  for (const m of value.matchAll(BRACKETED_MESSAGE_ID_RE)) {
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

const OUTBOUND_MESSAGE_ID_RE = /^<out-[^@>]+@([^@>]+)>$/i

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
  const fromAddress = mail.from?.address ?? null
  const fromDomain = domainOf(fromAddress)
  if (fromAddress === null || fromDomain === null) return false
  const recipients = await mailRepo.outboundRecipients(threadId)
  const sender = normalizedMailbox(fromAddress)
  for (const recipient of recipients) {
    const contactDomain = domainOf(recipient)
    if (contactDomain === null) continue
    if (isConsumerMailDomain(contactDomain)) {
      if (normalizedMailbox(recipient) === sender) return true
    } else if (domainsAligned(fromDomain, contactDomain)) {
      return true
    }
  }
  return false
}

const BRACKETED_MAILBOX_RE = /<([^<>]*)>/

// Provider aliasing (Gmail dots, +tags, googlemail.com) is deliberately not folded: every folding
// rule widens the set of mailboxes that count as the contact.
function normalizedMailbox(address: string): string {
  return (BRACKETED_MAILBOX_RE.exec(address)?.[1] ?? address).trim().toLowerCase()
}

function isConsumerMailDomain(domain: string): boolean {
  return CONSUMER_MAIL_DOMAINS.has(organizationalDomain(domain) ?? domain)
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
      await onJurisdictionReply(container, injected, mailRepo, thread, message, stage)
    } else {
      await onEventReply(container, injected.cleanupRepo, mailRepo, thread, message, stage)
    }
    await mailRepo.markMessageEffectsApplied(message.id)
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

async function onJurisdictionReply(
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

  if (stage < EFFECTS_STAGE_TIMELINE) {
    const advances = record.status === "published" || record.status === "acknowledged"
    if (advances) {
      await reportRepo.setStatus(reportId, {
        status: "in_progress",
        note: JURISDICTION_REPLY_NOTE,
        actorId: null,
        kind: "reply",
        body: null,
      })
    } else {
      await reportRepo.appendSystemTimeline(reportId, {
        note: JURISDICTION_REPLY_NOTE,
        kind: "reply",
        body: null,
      })
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
      note: JURISDICTION_REPLY_NOTE,
      body: cityReplyChatBody(message.body, container.env.MAIL_REPLY_DOMAIN),
    })
    await mailRepo.setMessageEffectsStage(messageId, EFFECTS_STAGE_CHAT)
  }

  if (stage < EFFECTS_STAGE_NOTIFIED) {
    const reporterUserId = record.reporter?.id
    if (reporterUserId && reporterUserId !== "") {
      const notifications = injected.notifications ?? container.getNotificationService()
      await notifications.createNotification(reporterUserId, {
        type: "report_update",
        title: JURISDICTION_REPLY_NOTIFICATION_TITLE,
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
    await cleanupRepo.appendCleanupTimeline(cleanupId, {
      kind: "city_reply",
      note:
        cityReplyChatBody(message.body, container.env.MAIL_REPLY_DOMAIN) ??
        EVENT_REPLY_FALLBACK_NOTE,
      actorId: null,
    })
    await mailRepo.setMessageEffectsStage(message.id, EFFECTS_STAGE_TIMELINE)
  }
  await mailRepo.setThreadStatus(thread.id, "replied")
}

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
  return `${DERIVED_ID_PREFIX}${sha256HexSync(basis)}`
}
