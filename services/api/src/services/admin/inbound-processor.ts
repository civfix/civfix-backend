/**
 * Inbound-mail processor: the ONE place that turns a buffered R2 object into a persisted email. Both the
 * webhook (low-latency nudge) and the boot/cron sweep (durable backstop) call processInboundObject, so
 * they share routing + idempotency exactly. Bounce detection lives in inbound-bounce.ts and thread
 * correlation in inbound-thread-correlation.ts; this orchestrator wires them over the R2 fetch/parse/route
 * flow.
 *
 * For key `inbound/pending/<id>.eml`: GET bytes -> parse -> extractThreadToken; token (or In-Reply-To
 * fallback) -> thread into mail_threads; else catch-all into inbound_emails (the admin Inbox). A bounce is
 * routed to the Inbox + correlated. On terminal success the pending object is DELETEd; a parse failure (or
 * an over-cap object) is MOVED to inbound/failed/ so the sweep never loops on a poison message.
 *
 * INVARIANT: processInboundObject NEVER throws for content reasons; an unexpected infra error propagates
 * to the caller (the webhook swallows it -> still 202; the sweep counts it and continues).
 */

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

// Re-export the split modules' public surface so external importers (tests) resolve via this barrel.
export { detectBounce, resolveMessageId, parseMessageIdList, type BounceDetection }

/** Prefix the Cloudflare Email Worker writes raw .eml objects under (the sweep's work queue). */
export const INBOUND_PENDING_PREFIX = "inbound/pending/"
/** Where a parse-poisoned object is parked so the sweep stops reprocessing it. */
const INBOUND_FAILED_PREFIX = "inbound/failed/"
/** A pending key looks like inbound/pending/<slug>.eml. The sweep + webhook validate against this. */
export const INBOUND_PENDING_KEY_RE = /^inbound\/pending\/[^/]+\.eml$/

/** Max attachment size streamed into R2; larger is preserved by reference (flagged), not buffered. */
export const INBOUND_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

/**
 * Hard cap on the raw .eml bytes that may reach the in-process mailparser. Slightly above Cloudflare Email
 * Routing's 25 MiB platform limit (header/encoding overhead) so a legitimate message is never rejected,
 * while a crafted oversized object cannot exhaust API memory in simpleParser. An object over this cap is
 * parked in inbound/failed/ (poison-message convention) rather than parsed.
 */
export const INBOUND_OBJECT_MAX_BYTES = 30 * 1024 * 1024

export type ProcessOutcome = "threaded" | "inbox" | "replay" | "skipped" | "failed"

export interface ProcessResult {
  outcome: ProcessOutcome
  reason?: string
  id?: string
}

/** Optional injected seams (tests). Anything omitted is taken from the container. */
export interface InboundProcessorDeps {
  storage?: Storage
  inboundMail?: InboundMail
  mailRepo?: MailRepository
  inboundRepo?: InboundRepository
  /** The admin-report repo for a jurisdiction-reply's report side-effects; injectable so tests use the
   *  in-memory impl (the side-effects are otherwise the only reason the processor touches the report repo). */
  adminReportRepo?: AdminReportRepository
  /** The cleanup repo for an EVENT-reply's cleanup_timeline side-effect (D13/D19); injectable for tests. */
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
  // The report/cleanup repos (for a reply's side-effects) are resolved LAZILY in onJurisdictionReply /
  // onEventReply — only when a thread actually carries the matching id — so a no-reply inbound never touches
  // them and a container without getDb() (e.g. the webhook unit harness) is never dereferenced on the
  // common path.
  const injectedReportRepo = deps.adminReportRepo
  const injectedCleanupRepo = deps.cleanupRepo

  const bytes = await storage.getObject(key)
  if (bytes === null) {
    return { outcome: "skipped", reason: "missing" }
  }

  // SECURITY (DoS): bound the raw bytes that ever reach the in-process mailparser. A crafted oversized
  // .eml would otherwise be fully buffered + parsed in the API process. Park it (same poison handling as a
  // parse failure) so the sweep does not loop on it.
  if (bytes.byteLength > INBOUND_OBJECT_MAX_BYTES) {
    await moveToFailed(storage, key, bytes)
    return { outcome: "failed", reason: "too-large" }
  }

  let mail: ParsedMail
  try {
    mail = await inboundMail.parse(bytes)
  } catch {
    await moveToFailed(storage, key, bytes)
    return { outcome: "failed", reason: "parse-failed" }
  }

  const messageId = resolveMessageId(mail)

  // A DSN/bounce is filed in the Inbox for operator visibility (idempotent on message_id) AND, the FIRST
  // time it is seen (outcome 'inbox', not 'replay'), correlated to its outbound thread — so a re-delivered
  // DSN never double-records the 'bounced' event or re-stamps the contact.
  const bounce = detectBounce(mail)
  if (bounce.isBounce) {
    const result = await routeInbox(storage, inboundRepo, key, mail, messageId)
    if (result.outcome === "inbox") {
      await handleBounce(container, mailRepo, bounce).catch(() => {})
    }
    if (result.outcome === "inbox" || result.outcome === "replay") await storage.delete(key)
    return result
  }

  let token: string | null = null
  try {
    token = inboundMail.extractThreadToken(mail)
  } catch {
    token = null
  }

  // TOKEN FALLBACK: when the plus-address reply token is absent (some clients strip it), correlate the
  // reply to its outbound thread by the In-Reply-To / References headers; else fall through to the Inbox.
  let fallbackThread: MailThreadRecord | null = null
  if (token === null || token.length === 0) {
    fallbackThread = await findThreadByReferences(mailRepo, mail).catch(() => null)
  }

  let result: ProcessResult
  if (token !== null && token.length > 0) {
    result = await routeThreaded(container, injectedReportRepo, injectedCleanupRepo, storage, mailRepo, mail, token, messageId, null)
  } else if (fallbackThread !== null) {
    result = await routeThreaded(container, injectedReportRepo, injectedCleanupRepo, storage, mailRepo, mail, null, messageId, fallbackThread)
  } else {
    result = await routeInbox(storage, inboundRepo, key, mail, messageId)
  }

  if (result.outcome === "threaded" || result.outcome === "inbox" || result.outcome === "replay") {
    // Source-of-truth consumed: drop the pending object. Idempotent, so a webhook/sweep race is safe.
    await storage.delete(key)
  }
  return result
}

/**
 * Reply path: thread into mail_threads. Idempotent on message_id (skip a re-delivered reply). The thread
 * is resolved EITHER by the plus-address `token` (the normal path) OR pre-resolved via the In-Reply-To
 * fallback (`presolved`, token null). After a NON-replay insert, a per-report outreach thread fires
 * best-effort report side-effects (timeline + status + notify the reporter).
 */
async function routeThreaded(
  container: Container,
  injectedReportRepo: AdminReportRepository | undefined,
  injectedCleanupRepo: CleanupRepository | undefined,
  storage: Storage,
  mailRepo: MailRepository,
  mail: ParsedMail,
  token: string | null,
  messageId: string,
  presolved: MailThreadRecord | null,
): Promise<ProcessResult> {
  if (await mailRepo.messageExists(messageId)) return { outcome: "replay" }
  const thread =
    presolved ??
    (await mailRepo.upsertThreadByToken(token as string, {
      subject: mail.subject ?? undefined,
    }))
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
  // Dispatch by the id the thread carries: a report thread -> report timeline side-effects; an event
  // thread -> the cleanup_timeline 'city_reply' side-effect (D13/D19). A digest/compose thread carries
  // neither and fires nothing. Both side-effect paths are best-effort (failures swallowed).
  if (thread.reportId !== null) {
    await onJurisdictionReply(container, injectedReportRepo, mailRepo, thread, mail).catch(() => {})
  } else if (thread.cleanupId !== null) {
    await onEventReply(container, injectedCleanupRepo, mailRepo, thread, mail).catch(() => {})
  }
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
    // SECURITY: bodyHtml is UNTRUSTED raw HTML from an external (often spoofed) sender. It is stored
    // verbatim and MUST NOT be rendered with dangerouslySetInnerHTML in the admin reader without
    // sanitization (DOMPurify) — prefer rendering bodyText. Treat this column as attacker-controlled.
    bodyHtml: mail.html ?? null,
    headers: mail.headers,
    attachments,
  })
  return { outcome: inserted ? "inbox" : "replay", id }
}

/**
 * Stream a parsed mail's attachments into R2 under `keyPrefix`, returning the stored { key, filename,
 * size } refs + the names of any too large to buffer (preserved by reference, flagged). 25 MiB cap,
 * sanitized filenames, for both the threaded + catch-all paths.
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
    index += 1
    // Pre-download filter: an attachment whose declared size exceeds the cap is preserved by reference
    // (flagged, never buffered) — the provider reports size and may omit content for huge ones.
    if ((att.size ?? 0) > INBOUND_ATTACHMENT_MAX_BYTES) {
      oversize.push(filename)
      continue
    }
    const bytes = att.content ?? null
    if (bytes === null) continue
    // SECURITY: also cap on the ACTUAL bytes so a crafted att declaring `size: 1` while carrying tens of
    // MiB can't slip past (the declared size is attacker-controlled).
    if (bytes.byteLength > INBOUND_ATTACHMENT_MAX_BYTES) {
      oversize.push(filename)
      continue
    }
    const objKey = `${keyPrefix}/${index}-${sanitizeFilename(filename)}`
    // SECURITY (stored XSS / drive-by): the attachment's Content-Type is attacker-controlled (external
    // email parsed by mailparser). Stored verbatim, the operator inbox's presigned GET would serve e.g.
    // text/html or image/svg+xml INLINE and execute attacker script. Store every inbound attachment as
    // application/octet-stream so the browser DOWNLOADS it (never renders it); the original filename is
    // preserved in the DB row for the operator to see.
    await storage.put(objKey, bytes, { contentType: "application/octet-stream" })
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

/** Reduce a filename to a safe object-key segment (no path separators / control chars). */
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "")
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "file"
}
