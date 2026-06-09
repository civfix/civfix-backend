/**
 * Inbound-mail processor: the ONE place that turns a buffered R2 object into a persisted email. Both
 * the webhook (low-latency nudge) and the boot/cron sweep (durable backstop) call processInboundObject,
 * so they share routing + idempotency exactly.
 *
 * For key `inbound/pending/<id>.eml`:
 *   GET bytes -> parse -> extractThreadToken
 *     token present -> reply: upsert mail_threads thread + insert mail_messages (idempotent on
 *                      message_id) + stream attachments + record a 'delivered' event.
 *     no token      -> catch-all: insert inbound_emails (idempotent on the UNIQUE message_id) + stream
 *                      attachments. This is the admin Inbox.
 *   on a terminal success -> DELETE the pending object (idempotent).
 *   parse failure -> MOVE the object to inbound/failed/ so the sweep never loops on a poison message.
 *
 * processInboundObject NEVER throws for content reasons; an unexpected infra error propagates to the
 * caller (the webhook swallows it -> still 202; the sweep counts it and continues).
 */

import { createHash } from "node:crypto"
import type { Container } from "../../di.js"
import type { InboundMail, ParsedMail, Storage } from "@civfix/shared/interfaces"
import type { MailAttachment } from "@civfix/shared"
import { makeDrizzleMailRepository, type MailRepository } from "./mail-repository.drizzle.js"
import {
  makeDrizzleInboundRepository,
  type InboundRepository,
} from "./inbound-repository.drizzle.js"

/** Prefix the Cloudflare Email Worker writes raw .eml objects under (the sweep's work queue). */
export const INBOUND_PENDING_PREFIX = "inbound/pending/"
/** Where a parse-poisoned object is parked so the sweep stops reprocessing it. */
export const INBOUND_FAILED_PREFIX = "inbound/failed/"
/** A pending key looks like inbound/pending/<slug>.eml. The sweep + webhook validate against this. */
export const INBOUND_PENDING_KEY_RE = /^inbound\/pending\/[^/]+\.eml$/

/** Max attachment size streamed into R2; larger is preserved by reference (flagged), not buffered. */
export const INBOUND_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

export type ProcessOutcome = "threaded" | "inbox" | "replay" | "skipped" | "failed"

export interface ProcessResult {
  outcome: ProcessOutcome
  /** Why a non-success outcome happened (missing / parse-failed). */
  reason?: string
  /** The created message / inbound-email id on a success outcome. */
  id?: string
}

/** Optional injected seams (tests). Anything omitted is taken from the container. */
export interface InboundProcessorDeps {
  storage?: Storage
  inboundMail?: InboundMail
  mailRepo?: MailRepository
  inboundRepo?: InboundRepository
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

  const bytes = await storage.getObject(key)
  if (bytes === null) {
    // Already processed + deleted by the racing path (or never written). Nothing to do.
    return { outcome: "skipped", reason: "missing" }
  }

  let mail: ParsedMail
  try {
    mail = await inboundMail.parse(bytes)
  } catch {
    await moveToFailed(storage, key, bytes)
    return { outcome: "failed", reason: "parse-failed" }
  }

  const messageId = resolveMessageId(mail)
  let token: string | null = null
  try {
    token = inboundMail.extractThreadToken(mail)
  } catch {
    token = null
  }

  const result =
    token !== null && token.length > 0
      ? await routeThreaded(storage, mailRepo, mail, token, messageId)
      : await routeInbox(storage, inboundRepo, key, mail, messageId)

  if (result.outcome === "threaded" || result.outcome === "inbox" || result.outcome === "replay") {
    // Source-of-truth consumed: drop the pending object. Idempotent, so a webhook/sweep race is safe.
    await storage.delete(key)
  }
  return result
}

/** Reply path: thread into mail_threads. Idempotent on message_id (skip a re-delivered reply). */
async function routeThreaded(
  storage: Storage,
  mailRepo: MailRepository,
  mail: ParsedMail,
  token: string,
  messageId: string,
): Promise<ProcessResult> {
  if (await mailRepo.messageExists(messageId)) return { outcome: "replay" }
  const thread = await mailRepo.upsertThreadByToken(token, {
    subject: mail.subject ?? undefined,
  })
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
  return { outcome: "threaded", id: message.id }
}

/** Catch-all path: insert into inbound_emails (admin Inbox). Idempotent on the UNIQUE message_id. */
async function routeInbox(
  storage: Storage,
  inboundRepo: InboundRepository,
  key: string,
  mail: ParsedMail,
  messageId: string,
): Promise<ProcessResult> {
  // Attachment folder = the worker's key slug (already object-key-safe), so it is stable across replays.
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
    bodyText: mail.text ?? null,
    bodyHtml: mail.html ?? null,
    headers: mail.headers,
    attachments,
  })
  return { outcome: inserted ? "inbox" : "replay", id }
}

/**
 * Stream a parsed mail's attachments into R2 under `keyPrefix`, returning the stored { key, filename,
 * size } refs + the names of any too large to buffer (preserved by reference, flagged). Mirrors the
 * Phase 2 webhook's behavior (25 MiB cap, sanitized filenames) for both the threaded + catch-all paths.
 */
async function streamAttachments(
  storage: Storage,
  keyPrefix: string,
  mail: ParsedMail,
): Promise<{ attachments: MailAttachment[]; oversize: string[] }> {
  const attachments: MailAttachment[] = []
  const oversize: string[] = []
  let index = 0
  for (const att of mail.attachments ?? []) {
    const filename = att.filename && att.filename.length > 0 ? att.filename : `attachment-${index}`
    const bytes = att.content ?? null
    const size = att.size ?? bytes?.byteLength ?? 0
    index += 1
    if (size > INBOUND_ATTACHMENT_MAX_BYTES || bytes === null) {
      if (size > INBOUND_ATTACHMENT_MAX_BYTES) oversize.push(filename)
      continue
    }
    const objKey = `${keyPrefix}/${index}-${sanitizeFilename(filename)}`
    await storage.put(objKey, bytes, att.contentType !== undefined ? { contentType: att.contentType } : {})
    attachments.push({ key: objKey, filename, size: bytes.byteLength })
  }
  return { attachments, oversize }
}

/** Copy the raw object to inbound/failed/ then delete it from pending. Best-effort. */
async function moveToFailed(storage: Storage, key: string, bytes: Uint8Array): Promise<void> {
  const failedKey = key.startsWith(INBOUND_PENDING_PREFIX)
    ? INBOUND_FAILED_PREFIX + key.slice(INBOUND_PENDING_PREFIX.length)
    : INBOUND_FAILED_PREFIX + key
  try {
    await storage.put(failedKey, bytes, { contentType: "message/rfc822" })
    await storage.delete(key)
  } catch {
    // Leave the object in place if the move fails; a later sweep retries the move.
  }
}

/**
 * The dedup key: the RFC822 Message-ID when present, else a stable hash of from/date/subject/body-length
 * so a re-delivered email without a Message-ID still collides. Never null (the columns dedup on it).
 */
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

/** Reduce a filename to a safe object-key segment (no path separators / control chars). */
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "")
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "file"
}
