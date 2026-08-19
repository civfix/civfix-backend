
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
import type { AdminReportRepository } from "./admin-report-service.js"
import { detectBounce, handleBounce, type BounceDetection } from "./inbound-bounce.js"
import {
  findThreadByReferences,
  onEventReply,
  onJurisdictionReply,
  parseMessageIdList,
  resolveMessageId,
} from "./inbound-thread-correlation.js"
import type { CleanupRepository } from "../cleanup-service.js"
import { readMailAuthVerdict, type MailAuthVerdict } from "../../adapters/inbound-mail.cf.js"
import { sanitizeInboundHtml } from "./inbound-html-sanitizer.js"

export { detectBounce, resolveMessageId, parseMessageIdList, type BounceDetection }
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

export interface InboundProcessorDeps {
  storage?: Storage
  inboundMail?: InboundMail
  mailRepo?: MailRepository
  inboundRepo?: InboundRepository
  adminReportRepo?: AdminReportRepository
  cleanupRepo?: CleanupRepository
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
  const injectedReportRepo = deps.adminReportRepo
  const injectedCleanupRepo = deps.cleanupRepo

  const bytes = await storage.getObject(key)
  if (bytes === null) {
    return { outcome: "skipped", reason: "missing" }
  }

  if (bytes.byteLength > INBOUND_OBJECT_MAX_BYTES) {
    await moveToFailed(storage, key, bytes)
    return { outcome: "failed", reason: "too-large" }
  }

  let mail: ParsedMail
  try {
    mail = await withTimeout(inboundMail.parse(bytes), INBOUND_PARSE_TIMEOUT_MS)
  } catch {
    await moveToFailed(storage, key, bytes)
    return { outcome: "failed", reason: "parse-failed" }
  }

  const messageId = resolveMessageId(mail)

  const bounce = detectBounce(mail)
  if (bounce.isBounce) {
    const result = await routeInbox(
      storage,
      inboundRepo,
      key,
      mail,
      messageId,
      readMailAuthVerdict(mail),
    )
    if (result.outcome === "inbox") {
      await handleBounce(container, mailRepo, bounce).catch(() => {})
    }
    if (result.outcome === "inbox" || result.outcome === "replay") await storage.delete(key)
    return result
  }

  const authVerdict = readMailAuthVerdict(mail)
  if (authVerdict !== "pass") {
    const result = await routeInbox(storage, inboundRepo, key, mail, messageId, authVerdict)
    if (result.outcome === "inbox" || result.outcome === "replay") await storage.delete(key)
    return result
  }

  let token: string | null = null
  try {
    token = inboundMail.extractThreadToken(mail)
  } catch {
    token = null
  }

  let resolvedThread: MailThreadRecord | null = null
  if (token !== null && token.length > 0) {
    resolvedThread = await mailRepo.findThreadByToken(token).catch(() => null)
  }
  if (resolvedThread === null) {
    resolvedThread = await findThreadByReferences(mailRepo, mail).catch(() => null)
  }

  let result: ProcessResult
  if (resolvedThread !== null) {
    result = await routeThreaded(
      container,
      injectedReportRepo,
      injectedCleanupRepo,
      storage,
      mailRepo,
      mail,
      messageId,
      resolvedThread,
    )
  } else {
    result = await routeInbox(storage, inboundRepo, key, mail, messageId, authVerdict)
  }

  if (result.outcome === "threaded" || result.outcome === "inbox" || result.outcome === "replay") {
    await storage.delete(key)
  }
  return result
}

async function routeThreaded(
  container: Container,
  injectedReportRepo: AdminReportRepository | undefined,
  injectedCleanupRepo: CleanupRepository | undefined,
  storage: Storage,
  mailRepo: MailRepository,
  mail: ParsedMail,
  messageId: string,
  thread: MailThreadRecord,
): Promise<ProcessResult> {
  const { attachments, oversize } = await streamAttachments(storage, `inbound-mail/${thread.id}`, mail)
  const message = await mailRepo.insertMessage({
    threadId: thread.id,
    direction: "in",
    fromAddr: mail.from?.address ?? null,
    toAddr: mail.to[0]?.address ?? null,
    subject: mail.subject ?? null,
    body: mail.text ?? mail.html ?? null,
    attachments,
    messageId,
    inReplyTo: mail.inReplyTo ?? null,
  })
  if (message === null) return { outcome: "replay" }
  await mailRepo.recordEvent({
    threadId: thread.id,
    messageId: message.id,
    type: "delivered",
    meta: {
      direction: "in",
      from: mail.from?.address ?? null,
      messageId,
      ...(oversize.length > 0 ? { oversizeAttachments: oversize } : {}),
    },
  })
  if (thread.reportId !== null) {
    await onJurisdictionReply(container, injectedReportRepo, mailRepo, thread, mail).catch(() => {})
  } else if (thread.cleanupId !== null) {
    await onEventReply(container, injectedCleanupRepo, mailRepo, thread, mail).catch(() => {})
  }
  return { outcome: "threaded", id: message.id }
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
  const { id, inserted } = await inboundRepo.insertIdempotent({
    messageId,
    fromAddr: mail.from?.address ?? null,
    toAddr,
    recipient,
    subject: mail.subject ?? null,
    bodyText: clipBodyText(mail.text),
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
  try {
    await storage.put(failedKey, bytes, { contentType: "message/rfc822" })
    await storage.delete(key)
  } catch {
    void 0
  }
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "")
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "file"
}
