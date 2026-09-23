
import type { Container } from "../../di.js"
import type { InboundMail, ParsedMail, Storage } from "@civfix/shared/interfaces"
import type { MailAttachment } from "@civfix/shared"
import {
  makeDrizzleMailRepository,
  type MailRepository,
  type MailThreadRecord,
} from "./mail-repository.drizzle.js"
import {
  makeDrizzleInboundRepository,
  type InboundRepository,
} from "./inbound-repository.drizzle.js"
import type { AdminReportRepository, ReporterNotifier } from "./admin-report-service.js"
import { detectBounce, handleBounce, type BounceDetection } from "./inbound-bounce.js"
import {
  applyInboundEffects,
  findThreadByReferences,
  inboundEffectDeps,
  type InboundEffectDeps,
  type InboundLogger,
  isJurisdictionSender,
  isSelfOriginated,
  parseMessageIdList,
  resolveMessageId,
} from "./inbound-thread-correlation.js"
import type { CleanupRepository } from "../cleanup-service.js"
import type { ReportChatSystemEmitter } from "../report-timeline-event.js"
import { readMailAuthVerdict, type MailAuthVerdict } from "../../adapters/inbound-mail.cf.js"
import { sanitizeInboundHtml } from "./inbound-html-sanitizer.js"
import { htmlToText } from "./mail-preview.js"

export {
  detectBounce,
  resolveMessageId,
  parseMessageIdList,
  type BounceDetection,
  type InboundLogger,
}
export { readMailAuthVerdict, sanitizeInboundHtml, type MailAuthVerdict }

export const INBOUND_PENDING_PREFIX = "inbound/pending/"
const INBOUND_FAILED_PREFIX = "inbound/failed/"
export const INBOUND_PENDING_KEY_RE = /^inbound\/pending\/[^/]+\.eml$/

export const INBOUND_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

export const INBOUND_ATTACHMENT_MAX_COUNT = 50
export const INBOUND_ATTACHMENT_TOTAL_MAX_BYTES = 30 * 1024 * 1024

export const INBOUND_OBJECT_MAX_BYTES = 30 * 1024 * 1024

export const INBOUND_PARSE_TIMEOUT_MS = 20_000

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("inbound parse timed out")), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export type ProcessOutcome = "threaded" | "inbox" | "replay" | "skipped" | "failed"

export interface ProcessResult {
  outcome: ProcessOutcome
  reason?: string
  id?: string
}

const NOOP_LOGGER: InboundLogger = { warn: () => {}, error: () => {} }

export interface InboundProcessorDeps {
  logger?: InboundLogger
  storage?: Storage
  inboundMail?: InboundMail
  mailRepo?: MailRepository
  inboundRepo?: InboundRepository
  adminReportRepo?: AdminReportRepository
  cleanupRepo?: CleanupRepository
  notifications?: ReporterNotifier
  chatEmitter?: ReportChatSystemEmitter
}

export async function processInboundObject(
  container: Container,
  key: string,
  deps: InboundProcessorDeps = {},
): Promise<ProcessResult> {
  const storage = deps.storage ?? container.inboundStorage
  const inboundMail = deps.inboundMail ?? container.inboundMail
  const mailRepo = deps.mailRepo ?? makeDrizzleMailRepository(container.getDb().sql)
  const inboundRepo = deps.inboundRepo ?? makeDrizzleInboundRepository(container.getDb().sql)
  const injected = inboundEffectDeps(deps)
  const logger = deps.logger ?? NOOP_LOGGER

  const bytes = await storage.getObject(key)
  if (bytes === null) {
    return { outcome: "skipped", reason: "missing" }
  }

  if (bytes.byteLength > INBOUND_OBJECT_MAX_BYTES) {
    logger.warn(
      { key, bytes: bytes.byteLength },
      "inbound: object over the size cap; parked under inbound/failed/",
    )
    await moveToFailed(storage, key, bytes)
    return { outcome: "failed", reason: "too-large" }
  }

  let mail: ParsedMail
  try {
    mail = await withTimeout(inboundMail.parse(bytes), INBOUND_PARSE_TIMEOUT_MS)
  } catch (err) {
    logger.warn({ key, err: errorText(err) }, "inbound: parse failed; parked under inbound/failed/")
    await moveToFailed(storage, key, bytes)
    return { outcome: "failed", reason: "parse-failed" }
  }

  const messageId = resolveMessageId(mail)

  const bounce = detectBounce(mail)
  if (bounce.isBounce) {
    const bounceVerdict = readMailAuthVerdict(mail)
    const result = await routeInbox(storage, inboundRepo, key, mail, messageId, bounceVerdict)
    if (result.outcome === "inbox") {
      await handleBounce(container, mailRepo, bounce, {
        fromAddr: mail.from?.address ?? null,
        authVerdict: bounceVerdict,
      }).catch((err: unknown) => {
        logger.warn({ key, err: errorText(err) }, "inbound: bounce bookkeeping failed")
      })
    }
    if (result.outcome === "inbox" || result.outcome === "replay") await storage.delete(key)
    return result
  }

  if (isSelfOriginated(container, mail, messageId)) {
    logger.warn({ key, messageId }, "inbound: dropped our own outbound mail looping back")
    await storage.delete(key)
    return { outcome: "skipped", reason: "self-originated" }
  }

  const authVerdict = readMailAuthVerdict(mail)
  const resolvedThread =
    mail.from === null ? null : await correlateThread(inboundMail, mailRepo, mail, authVerdict)

  const result =
    resolvedThread === null
      ? await routeInbox(storage, inboundRepo, key, mail, messageId, authVerdict)
      : await routeThreaded(
          container,
          injected,
          storage,
          mailRepo,
          mail,
          messageId,
          resolvedThread,
          authVerdict,
          logger,
        )

  if (result.outcome === "threaded" || result.outcome === "inbox" || result.outcome === "replay") {
    await storage.delete(key)
  }
  return result
}

async function correlateThread(
  inboundMail: InboundMail,
  mailRepo: MailRepository,
  mail: ParsedMail,
  authVerdict: MailAuthVerdict,
): Promise<MailThreadRecord | null> {
  let token: string | null = null
  try {
    token = inboundMail.extractThreadToken(mail)
  } catch {
    token = null
  }

  let resolvedThread: MailThreadRecord | null = null
  if (token !== null && token.length > 0) {
    resolvedThread = await mailRepo.findThreadByToken(token)
  }
  if (resolvedThread !== null || authVerdict !== "pass") return resolvedThread
  return findThreadByReferences(mailRepo, mail)
}

async function routeThreaded(
  container: Container,
  injected: InboundEffectDeps,
  storage: Storage,
  mailRepo: MailRepository,
  mail: ParsedMail,
  messageId: string,
  thread: MailThreadRecord,
  authVerdict: MailAuthVerdict,
  logger: InboundLogger,
): Promise<ProcessResult> {
  const unaffiliated =
    authVerdict !== "pass" || !(await isJurisdictionSender(mailRepo, thread.id, mail))
  const { attachments, oversize } = await streamAttachments(storage, `inbound-mail/${thread.id}`, mail)
  const inserted = await mailRepo.insertMessage({
    threadId: thread.id,
    direction: "in",
    fromAddr: mail.from?.address ?? null,
    toAddr: mail.to[0]?.address ?? null,
    subject: mail.subject ?? null,
    body: plainTextBody(mail),
    attachments,
    messageId,
    inReplyTo: mail.inReplyTo ?? null,
    unaffiliated,
  })
  if (inserted !== null) {
    await mailRepo.recordEvent({
      threadId: thread.id,
      messageId: inserted.id,
      type: "delivered",
      meta: {
        direction: "in",
        from: mail.from?.address ?? null,
        messageId,
        authVerdict,
        ...(unaffiliated ? { unaffiliated: true } : {}),
        ...(oversize.length > 0 ? { oversizeAttachments: oversize } : {}),
      },
    })
  }

  const message = inserted ?? (await mailRepo.findMessageByMessageId(messageId).catch(() => null))
  if (message !== null && message.threadId === thread.id) {
    await applyInboundEffects(container, injected, mailRepo, thread, message).catch((err: unknown) => {
      logger.warn(
        { err: errorText(err), threadId: thread.id, messageId: message.id },
        "inbound: side effects failed (claim released; the sweep re-drives it)",
      )
    })
  }
  if (inserted === null) return { outcome: "replay" }
  return { outcome: "threaded", id: inserted.id }
}

function plainTextBody(mail: ParsedMail): string | null {
  if (mail.text !== null && mail.text !== undefined) return clipBodyText(mail.text)
  if (mail.html === null || mail.html === undefined || mail.html.length === 0) return null
  return clipBodyText(htmlToText(mail.html.slice(0, INBOUND_HTML_SOURCE_MAX_CHARS)))
}

export const INBOUND_HTML_SOURCE_MAX_CHARS = 1024 * 1024

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function routeInbox(
  storage: Storage,
  inboundRepo: InboundRepository,
  key: string,
  mail: ParsedMail,
  messageId: string,
  authVerdict: MailAuthVerdict,
): Promise<ProcessResult> {
  const folder = key.startsWith(INBOUND_PENDING_PREFIX)
    ? key.slice(INBOUND_PENDING_PREFIX.length).replace(/\.eml$/i, "")
    : sanitizeFilename(messageId)
  const { attachments } = await streamAttachments(storage, `inbound-emails/${folder}`, mail)
  const recipient = mail.to[0]?.address ?? null
  const toAddr =
    mail.to
      .map((a) => a.address)
      .filter((a) => a.length > 0)
      .join(", ") || null
  const claimedFrom = mail.headers["from"]?.slice(0, INBOUND_HEADER_VALUE_MAX_CHARS) || null
  const { id, inserted } = await inboundRepo.insertIdempotent({
    messageId,
    fromAddr: mail.from?.address ?? claimedFrom,
    toAddr,
    recipient,
    subject: mail.subject ?? null,
    bodyText: plainTextBody(mail),
    bodyHtml: sanitizeInboundHtml(mail.html),
    headers: buildStoredHeaders(mail.headers, authVerdict),
    attachments,
  })
  return { outcome: inserted ? "inbox" : "replay", id }
}

export const INBOUND_BODY_TEXT_MAX_CHARS = 256 * 1024
const INBOUND_HEADER_VALUE_MAX_CHARS = 4 * 1024

function clipBodyText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null
  if (text.length <= INBOUND_BODY_TEXT_MAX_CHARS) return text
  return `${text.slice(0, INBOUND_BODY_TEXT_MAX_CHARS)}\n… [truncated]`
}

const STORED_HEADER_ALLOWLIST = new Set([
  "from",
  "to",
  "cc",
  "subject",
  "date",
  "message-id",
  "in-reply-to",
  "references",
  "authentication-results",
  "content-type",
  "x-failed-recipients",
])

function buildStoredHeaders(
  headers: Record<string, string>,
  authVerdict: MailAuthVerdict,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [rawKey, value] of Object.entries(headers)) {
    const key = rawKey.toLowerCase()
    if (!STORED_HEADER_ALLOWLIST.has(key) && !key.startsWith("x-civfix-")) continue
    if (typeof value !== "string") continue
    out[key] =
      value.length > INBOUND_HEADER_VALUE_MAX_CHARS
        ? value.slice(0, INBOUND_HEADER_VALUE_MAX_CHARS)
        : value
  }
  out["x-civfix-auth-verdict"] = authVerdict
  return out
}

async function streamAttachments(
  storage: Storage,
  keyPrefix: string,
  mail: ParsedMail,
): Promise<{ attachments: MailAttachment[]; oversize: string[] }> {
  const attachments: MailAttachment[] = []
  const oversize: string[] = []
  let index = 0
  let totalBytes = 0
  const all = mail.attachments ?? []
  for (const att of all) {
    const filename = att.filename && att.filename.length > 0 ? att.filename : `attachment-${index}`
    index += 1
    if (attachments.length >= INBOUND_ATTACHMENT_MAX_COUNT) {
      recordSkipped(oversize, filename)
      continue
    }
    if ((att.size ?? 0) > INBOUND_ATTACHMENT_MAX_BYTES) {
      recordSkipped(oversize, filename)
      continue
    }
    const bytes = att.content ?? null
    if (bytes === null) continue
    if (bytes.byteLength > INBOUND_ATTACHMENT_MAX_BYTES) {
      recordSkipped(oversize, filename)
      continue
    }
    if (totalBytes + bytes.byteLength > INBOUND_ATTACHMENT_TOTAL_MAX_BYTES) {
      recordSkipped(oversize, filename)
      continue
    }
    const objKey = `${keyPrefix}/${index}-${sanitizeFilename(filename)}`
    await storage.put(objKey, bytes, { contentType: "application/octet-stream" })
    attachments.push({ key: objKey, filename, size: bytes.byteLength })
    totalBytes += bytes.byteLength
  }
  return { attachments, oversize }
}

function recordSkipped(oversize: string[], filename: string): void {
  if (oversize.length < INBOUND_ATTACHMENT_MAX_COUNT) oversize.push(filename)
}

async function moveToFailed(storage: Storage, key: string, bytes: Uint8Array): Promise<void> {
  const failedKey = key.startsWith(INBOUND_PENDING_PREFIX)
    ? INBOUND_FAILED_PREFIX + key.slice(INBOUND_PENDING_PREFIX.length)
    : INBOUND_FAILED_PREFIX + key
  await storage.put(failedKey, bytes, { contentType: "message/rfc822" })
  await storage.delete(key)
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "")
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "file"
}
