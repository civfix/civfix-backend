import { createHash } from "node:crypto"
import type { Container } from "../../di.js"
import type { InboundMail, ParsedMail, Storage } from "@civfix/shared/interfaces"
import type { MailAttachment } from "@civfix/shared"
import {
  makeDrizzleMailRepository,
  type MailMessageRecord,
  type MailRepository,
  type MailThreadRecord,
} from "./mail-repository.drizzle.js"
import {
  makeDrizzleInboundRepository,
  type InboundRepository,
} from "./inbound-repository.drizzle.js"
import type { AdminReportRepository, ReporterNotifier } from "./admin-report-service.js"
import { detectBounce, handleBounce } from "./inbound-bounce.js"
import {
  applyInboundEffects,
  findThreadByReferences,
  inboundEffectDeps,
  type InboundEffectDeps,
  type InboundLogger,
  isJurisdictionSender,
  isSelfOriginated,
  resolveMessageId,
} from "./inbound-thread-correlation.js"
import type { CleanupRepository } from "../cleanup-service.js"
import type { ReportChatSystemEmitter } from "../report-timeline-event.js"
import { readMailAuthVerdict, type MailAuthVerdict } from "../../adapters/inbound-mail.cf.js"
import { sanitizeInboundHtml } from "./inbound-html-sanitizer.js"
import { htmlToText } from "./mail-preview.js"

export { detectBounce, resolveMessageId }

export const INBOUND_PENDING_PREFIX = "inbound/pending/"
const INBOUND_FAILED_PREFIX = "inbound/failed/"
export const INBOUND_PENDING_KEY_RE = /^inbound\/pending\/[^/]+\.eml$/

export const INBOUND_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

export const INBOUND_ATTACHMENT_MAX_COUNT = 50
const INBOUND_ATTACHMENT_TOTAL_MAX_BYTES = 30 * 1024 * 1024

const INBOUND_OBJECT_MAX_BYTES = 30 * 1024 * 1024

export const INBOUND_PARSE_TIMEOUT_MS = 20_000

export const INBOUND_HTML_SOURCE_MAX_CHARS = 1024 * 1024
export const INBOUND_BODY_TEXT_MAX_CHARS = 256 * 1024
const INBOUND_HEADER_VALUE_MAX_CHARS = 4 * 1024
const BODY_TRUNCATION_MARKER = "\n… [truncated]"

const THREADED_ATTACHMENT_PREFIX = "inbound-mail/"
const INBOX_ATTACHMENT_PREFIX = "inbound-emails/"
const ATTACHMENT_CONTENT_TYPE = "application/octet-stream"
const RAW_MAIL_CONTENT_TYPE = "message/rfc822"
const ATTACHMENT_FILENAME_MAX_CHARS = 120

const CIVFIX_HEADER_PREFIX = "x-civfix-"
const AUTH_VERDICT_HEADER = `${CIVFIX_HEADER_PREFIX}auth-verdict`

// At the 5-minute sweep cadence this parks a DSN after roughly half an hour of failing bookkeeping, long
// enough to ride out a transient fault and short enough that poison DSNs cannot fill the sweep batch.
export const INBOUND_BOUNCE_MAX_ATTEMPTS = 6

const CONTENT_DIGEST_HEX_CHARS = 32

function contentDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, CONTENT_DIGEST_HEX_CHARS)
}

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
    const result = await routeInbox(storage, inboundRepo, bytes, mail, messageId, bounceVerdict)
    if (result.outcome !== "inbox" && result.outcome !== "replay") return result
    // A replay re-runs the bookkeeping too: the object is only still pending when an earlier run
    // stored the DSN but failed part-way through handleBounce.
    try {
      await handleBounce(container, mailRepo, bounce, {
        fromAddr: mail.from?.address ?? null,
        authVerdict: bounceVerdict,
      })
    } catch (err) {
      return deferOrParkBounce(storage, inboundRepo, logger, key, bytes, result, {
        originalMessageId: bounce.originalMessageId,
        err: errorText(err),
      })
    }
    await inboundRepo.clearBounceFailures(key)
    await storage.delete(key)
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
      ? await routeInbox(storage, inboundRepo, bytes, mail, messageId, authVerdict)
      : await routeThreaded(
          container,
          injected,
          storage,
          mailRepo,
          bytes,
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
    // The token is parsed out of sender-controlled recipient addresses; a malformed one means only
    // that this mail carries no usable token, so correlation falls through to References.
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
  raw: Uint8Array,
  mail: ParsedMail,
  messageId: string,
  thread: MailThreadRecord,
  authVerdict: MailAuthVerdict,
  logger: InboundLogger,
): Promise<ProcessResult> {
  const unaffiliated =
    authVerdict !== "pass" || !(await isJurisdictionSender(mailRepo, thread.id, mail))
  // Message-ID is globally unique, so a stored row means this mail can only be a replay. Skipping
  // the upload keeps a sender who reuses someone else's Message-ID from writing any object. A failed
  // lookup throws so the pending object stays for the sweep instead of being treated as new mail.
  const existing = await mailRepo.findMessageByMessageId(messageId)
  const insert =
    existing === null
      ? await insertThreadedMessage(storage, mailRepo, raw, mail, messageId, thread, unaffiliated)
      : null
  if (insert?.inserted === true) {
    await mailRepo.recordEvent({
      threadId: thread.id,
      messageId: insert.message.id,
      type: "delivered",
      meta: {
        direction: "in",
        from: mail.from?.address ?? null,
        messageId,
        authVerdict,
        ...(unaffiliated ? { unaffiliated: true } : {}),
        ...(insert.oversize.length > 0 ? { oversizeAttachments: insert.oversize } : {}),
      },
    })
  }

  // A failed re-read only defers the side effects: the sweep re-drives every message whose effects
  // were never applied.
  const message =
    existing ?? (insert === null ? null : insert.inserted ? insert.message : insert.stored)
  if (message !== null && message.threadId === thread.id) {
    await applyInboundEffects(container, injected, mailRepo, thread, message).catch(
      (err: unknown) => {
        logger.warn(
          { err: errorText(err), threadId: thread.id, messageId: message.id },
          "inbound: side effects failed (claim released; the sweep re-drives it)",
        )
      },
    )
  }
  if (insert?.inserted !== true) return { outcome: "replay" }
  return { outcome: "threaded", id: insert.message.id }
}

type ThreadedInsert =
  | { inserted: true; message: MailMessageRecord; oversize: string[] }
  | { inserted: false; stored: MailMessageRecord | null }

async function insertThreadedMessage(
  storage: Storage,
  mailRepo: MailRepository,
  raw: Uint8Array,
  mail: ParsedMail,
  messageId: string,
  thread: MailThreadRecord,
  unaffiliated: boolean,
): Promise<ThreadedInsert> {
  // One folder per raw message, as in routeInbox: a lost insert race discards the objects its row
  // does not hold, and a folder shared with another message of the thread would lose that message's
  // attachment.
  const { attachments, oversize } = await streamAttachments(
    storage,
    `${THREADED_ATTACHMENT_PREFIX}${thread.id}/${contentDigest(raw)}`,
    mail,
  )
  const message = await mailRepo.insertMessage({
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
  if (message !== null) return { inserted: true, message, oversize }
  const stored = await mailRepo.findMessageByMessageId(messageId)
  await discardUnreferenced(storage, attachments, stored?.attachments ?? [])
  return { inserted: false, stored }
}

function plainTextBody(mail: ParsedMail): string | null {
  if (mail.text !== null && mail.text !== undefined) return clipBodyText(mail.text)
  if (mail.html === null || mail.html === undefined || mail.html.length === 0) return null
  return clipBodyText(htmlToText(mail.html.slice(0, INBOUND_HTML_SOURCE_MAX_CHARS)))
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function routeInbox(
  storage: Storage,
  inboundRepo: InboundRepository,
  raw: Uint8Array,
  mail: ParsedMail,
  messageId: string,
  authVerdict: MailAuthVerdict,
): Promise<ProcessResult> {
  // One folder per raw message, never shared between rows: the retention reaper deletes a row's
  // attachment objects, so a folder another row also pointed at would lose that row's evidence.
  const { attachments } = await streamAttachments(
    storage,
    `${INBOX_ATTACHMENT_PREFIX}${contentDigest(raw)}`,
    mail,
  )
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
  if (!inserted) {
    const kept = (await inboundRepo.get(id))?.attachments ?? []
    await discardUnreferenced(storage, attachments, kept)
  }
  return { outcome: inserted ? "inbox" : "replay", id }
}

async function discardUnreferenced(
  storage: Storage,
  written: readonly MailAttachment[],
  kept: readonly MailAttachment[],
): Promise<void> {
  const keptKeys = new Set(kept.map((att) => att.key))
  const orphans = new Set(written.map((att) => att.key).filter((key) => !keptKeys.has(key)))
  for (const key of orphans) await storage.delete(key)
}

function clipBodyText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null
  if (text.length <= INBOUND_BODY_TEXT_MAX_CHARS) return text
  return `${text.slice(0, INBOUND_BODY_TEXT_MAX_CHARS)}${BODY_TRUNCATION_MARKER}`
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
    if (!STORED_HEADER_ALLOWLIST.has(key) && !key.startsWith(CIVFIX_HEADER_PREFIX)) continue
    if (typeof value !== "string") continue
    out[key] = value.slice(0, INBOUND_HEADER_VALUE_MAX_CHARS)
  }
  out[AUTH_VERDICT_HEADER] = authVerdict
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
    const objKey = `${keyPrefix}/${contentDigest(bytes)}/${sanitizeFilename(filename)}`
    await storage.put(objKey, bytes, { contentType: ATTACHMENT_CONTENT_TYPE })
    attachments.push({ key: objKey, filename, size: bytes.byteLength })
    totalBytes += bytes.byteLength
  }
  return { attachments, oversize }
}

function recordSkipped(oversize: string[], filename: string): void {
  if (oversize.length < INBOUND_ATTACHMENT_MAX_COUNT) oversize.push(filename)
}

async function deferOrParkBounce(
  storage: Storage,
  inboundRepo: InboundRepository,
  logger: InboundLogger,
  key: string,
  bytes: Uint8Array,
  result: ProcessResult,
  context: { originalMessageId: string | null; err: string },
): Promise<ProcessResult> {
  logger.warn({ key, ...context }, "inbound: bounce bookkeeping failed")
  const attempts = await inboundRepo.recordBounceFailure(key)
  if (attempts < INBOUND_BOUNCE_MAX_ATTEMPTS) return result
  logger.error(
    { key, attempts, originalMessageId: context.originalMessageId },
    "inbound: bounce bookkeeping kept failing; parked under inbound/failed/",
  )
  await moveToFailed(storage, key, bytes)
  await inboundRepo.clearBounceFailures(key)
  return { outcome: "failed", reason: "bounce-bookkeeping" }
}

async function moveToFailed(storage: Storage, key: string, bytes: Uint8Array): Promise<void> {
  const failedKey = key.startsWith(INBOUND_PENDING_PREFIX)
    ? INBOUND_FAILED_PREFIX + key.slice(INBOUND_PENDING_PREFIX.length)
    : INBOUND_FAILED_PREFIX + key
  await storage.put(failedKey, bytes, { contentType: RAW_MAIL_CONTENT_TYPE })
  await storage.delete(key)
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "")
  return cleaned.length > 0 ? cleaned.slice(0, ATTACHMENT_FILENAME_MAX_CHARS) : "file"
}
