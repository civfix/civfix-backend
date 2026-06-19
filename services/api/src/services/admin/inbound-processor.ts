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
import type { Sql } from "../../db/client.js"
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
import { makeDrizzleAdminReportRepository } from "./admin-report-repository.drizzle.js"
import type { AdminReportRepository } from "./admin-report-service.js"
import {
  JURISDICTION_DISCOVERY_JOB,
  type JurisdictionDiscoveryJob,
} from "../../services/jurisdiction-service.js"

/** Prefix the Cloudflare Email Worker writes raw .eml objects under (the sweep's work queue). */
export const INBOUND_PENDING_PREFIX = "inbound/pending/"
/** Where a parse-poisoned object is parked so the sweep stops reprocessing it. */
export const INBOUND_FAILED_PREFIX = "inbound/failed/"
/** A pending key looks like inbound/pending/<slug>.eml. The sweep + webhook validate against this. */
export const INBOUND_PENDING_KEY_RE = /^inbound\/pending\/[^/]+\.eml$/

/** Max attachment size streamed into R2; larger is preserved by reference (flagged), not buffered. */
export const INBOUND_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

/**
 * Hard cap on the raw .eml bytes that may reach the in-process mailparser. Slightly above Cloudflare
 * Email Routing's 25 MiB platform limit (to allow header/encoding overhead) so a legitimate message is
 * never rejected, while a crafted oversized object cannot exhaust API memory in simpleParser. An object
 * over this cap is parked in inbound/failed/ (poison-message convention) rather than parsed.
 */
export const INBOUND_OBJECT_MAX_BYTES = 30 * 1024 * 1024

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
  /** The admin-report repo for a jurisdiction-reply's report side-effects; injectable so tests can use the
   *  in-memory impl (the side-effects are otherwise the only reason the processor touches the report repo). */
  adminReportRepo?: AdminReportRepository
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
  // The report repo (for a jurisdiction-reply's side-effects) is resolved LAZILY in onJurisdictionReply —
  // only when a thread actually has a report_id — so a no-reply inbound never touches the report repo and a
  // container without getDb() (e.g. the webhook unit harness) is never dereferenced on the common path.
  const injectedReportRepo = deps.adminReportRepo

  const bytes = await storage.getObject(key)
  if (bytes === null) {
    // Already processed + deleted by the racing path (or never written). Nothing to do.
    return { outcome: "skipped", reason: "missing" }
  }

  // SECURITY (DoS): bound the raw bytes that ever reach the in-process mailparser. A crafted oversized
  // .eml would otherwise be fully buffered + parsed in the API process. Park it in inbound/failed/ so the
  // sweep does not loop on it (same poison-message handling as a parse failure below).
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

  // BOUNCE DETECTION (best-effort, never throws): a DSN/bounce is filed in the Inbox for operator
  // visibility (idempotent on message_id) AND, the FIRST time we see it, correlated to its outbound thread
  // (by the original Message-ID, else the failed recipient) so the thread is flipped to 'bounced' + a
  // 'bounced' event recorded + the contact flagged + discovery re-opened. The side-effects run ONLY when
  // routeInbox actually inserted (outcome 'inbox', not 'replay'), so a re-delivered DSN (webhook+sweep
  // race / MTA retry, same Message-ID) never double-records the 'bounced' event or re-stamps the contact —
  // mirroring the messageExists() idempotency guard the threaded reply path uses. A detection/correlation
  // miss degrades to a plain Inbox message.
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

  // TOKEN FALLBACK: when the plus-address reply token is absent (some clients strip it), try to correlate
  // the reply to its outbound thread by the In-Reply-To / References headers it echoes back. If a thread is
  // found we route as threaded into it; else the message falls through to the Inbox.
  let fallbackThread: MailThreadRecord | null = null
  if (token === null || token.length === 0) {
    fallbackThread = await findThreadByReferences(mailRepo, mail).catch(() => null)
  }

  let result: ProcessResult
  if (token !== null && token.length > 0) {
    result = await routeThreaded(container, injectedReportRepo, storage, mailRepo, mail, token, messageId, null)
  } else if (fallbackThread !== null) {
    result = await routeThreaded(container, injectedReportRepo, storage, mailRepo, mail, null, messageId, fallbackThread)
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
 * fallback (`presolved`, token null). After a NON-replay insert, if the thread is a per-report outreach
 * thread (reportId set), best-effort report side-effects fire (timeline + status + notify the reporter).
 */
async function routeThreaded(
  container: Container,
  injectedReportRepo: AdminReportRepository | undefined,
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
  // BEST-EFFORT report side-effects (a jurisdiction's reply -> report timeline + status + notify). Never
  // throws to the caller, and runs only for a per-report thread; a miss can't break inbound processing or
  // the pending-object delete that follows.
  if (thread.reportId !== null) {
    await onJurisdictionReply(container, injectedReportRepo, mailRepo, thread, mail).catch(() => {})
  }
  return { outcome: "threaded", id: message.id }
}

/**
 * Best-effort side-effects when a jurisdiction reply lands on a per-report outreach thread (§2.7): post the
 * reply to the report timeline (advancing published|acknowledged -> in_progress, else a system 'reply' row),
 * notify the original reporter (in-app), and flip the thread status to 'replied'. STRICTLY best-effort: any
 * failure is swallowed by the caller so inbound processing + the idempotency/delete flow are never broken.
 */
async function onJurisdictionReply(
  container: Container,
  injectedReportRepo: AdminReportRepository | undefined,
  mailRepo: MailRepository,
  thread: MailThreadRecord,
  mail: ParsedMail,
): Promise<void> {
  const reportId = thread.reportId
  if (reportId === null) return
  // Resolve the report repo lazily here (only reached for a per-report thread): use the injected one in
  // tests, else build the Drizzle repo over the live sql.
  const reportRepo = injectedReportRepo ?? makeDrizzleAdminReportRepository(container.getDb().sql)
  const record = await reportRepo.getReport(reportId)
  if (!record) return

  const preview = replyPreview(mail.text ?? mail.html ?? "")
  const note = `Jurisdiction replied — ${preview}`

  // Timeline + status: advance a live (published/acknowledged) report to in_progress with the reply note;
  // otherwise just record a system 'reply' timeline row (no status change, e.g. an already-resolved report).
  if (record.status === "published" || record.status === "acknowledged") {
    await reportRepo.setStatus(reportId, { status: "in_progress", note, actorId: null })
  } else {
    await reportRepo.appendSystemTimeline(reportId, { note, kind: "reply" })
  }

  // Notify the original reporter (in-app) when the report has a claimed account.
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

  // Flag the thread as replied (the mailbox + the report outreach status both read this).
  await mailRepo.setThreadStatus(thread.id, "replied")
}

/** First ~140 chars of an inbound reply body, whitespace-collapsed, for the timeline note + notification. */
function replyPreview(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim()
  return collapsed.length > 140 ? `${collapsed.slice(0, 140)}…` : collapsed
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
    // SECURITY (stored XSS / drive-by): the attachment's Content-Type is attacker-controlled (it comes
    // from external email parsed by mailparser). If we stored it verbatim, the operator inbox's presigned
    // GET would serve e.g. text/html or image/svg+xml INLINE and execute attacker script in the operator's
    // browser. Store every inbound attachment as application/octet-stream so the browser DOWNLOADS it
    // (never renders it); the original filename is preserved in the DB row for the operator to see.
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

/**
 * Find a thread by the In-Reply-To / References headers an inbound reply echoes back (the fallback when the
 * plus-address token is stripped). Collects In-Reply-To + every id in the References header and asks the
 * mail repo for a thread carrying any of them as an OUTBOUND Message-ID. Returns null when none correlate.
 */
async function findThreadByReferences(
  mailRepo: MailRepository,
  mail: ParsedMail,
): Promise<MailThreadRecord | null> {
  const ids: string[] = []
  if (mail.inReplyTo && mail.inReplyTo.length > 0) ids.push(mail.inReplyTo)
  for (const ref of parseMessageIdList(mail.headers["references"])) ids.push(ref)
  if (ids.length === 0) return null
  return mailRepo.findThreadByOutboundMessageIds(ids)
}

/** Split a References-style header value into its angle-bracketed Message-IDs (`<a@x> <b@y>` -> [..]). */
export function parseMessageIdList(value: string | undefined): string[] {
  if (!value || value.length === 0) return []
  const out: string[] = []
  const re = /<[^>]+>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) out.push(m[0])
  // A header may also carry bare (unbracketed) ids; if the bracket scan found nothing, fall back to splitting
  // on whitespace so a single bare Message-ID still correlates.
  if (out.length === 0) {
    for (const token of value.split(/\s+/)) {
      const t = token.trim()
      if (t.length > 0) out.push(t)
    }
  }
  return out
}

/** The result of bounce detection: whether the message is a DSN/bounce + the recovered correlation hints. */
export interface BounceDetection {
  isBounce: boolean
  failedRecipient: string | null
  originalMessageId: string | null
}

/**
 * Detect a delivery-status notification / bounce and recover the failed recipient + the original Message-ID
 * (best-effort, pure). A message is a bounce when its From is a mailer-daemon/postmaster, OR its
 * Content-Type is a `report-type=delivery-status` multipart, OR it carries an X-Failed-Recipients header.
 * The failed recipient comes from X-Failed-Recipients, else a `Final-Recipient:`/`To:` line in the body;
 * the original Message-ID from an `Original-Message-ID:`/`Message-ID:` line in the body.
 */
export function detectBounce(mail: ParsedMail): BounceDetection {
  const fromAddr = mail.from?.address ?? ""
  const contentType = mail.headers["content-type"] ?? ""
  const failedHeader = mail.headers["x-failed-recipients"] ?? ""
  const isBounce =
    /(mailer-daemon|postmaster)@/i.test(fromAddr) ||
    /report-type=["']?delivery-status/i.test(contentType) ||
    failedHeader.length > 0
  if (!isBounce) {
    return { isBounce: false, failedRecipient: null, originalMessageId: null }
  }
  const body = mail.text ?? mail.html ?? ""
  const failedRecipient =
    extractEmail(failedHeader) ??
    extractEmail(matchLine(body, /^final-recipient:\s*(?:rfc822;)?\s*(.+)$/im)) ??
    extractEmail(matchLine(body, /^to:\s*(.+)$/im))
  const originalMessageId =
    matchBracketId(matchLine(body, /^original-message-id:\s*(.+)$/im)) ??
    matchBracketId(matchLine(body, /^message-id:\s*(.+)$/im))
  return { isBounce: true, failedRecipient, originalMessageId }
}

/** Best-effort bounce side-effects: correlate the thread, record the bounce, flag the contact, re-open discovery. */
async function handleBounce(
  container: Container,
  mailRepo: MailRepository,
  bounce: BounceDetection,
): Promise<void> {
  // 1. Correlate to a thread: by the original Message-ID (the OUT message we sent), else skip the thread
  // side-effects (we still flag the contact + file the bounce in the Inbox below).
  let thread: MailThreadRecord | null = null
  if (bounce.originalMessageId !== null) {
    thread = await mailRepo
      .findThreadByOutboundMessageIds([bounce.originalMessageId])
      .catch(() => null)
  }
  if (thread !== null) {
    await mailRepo
      .recordEvent({
        threadId: thread.id,
        type: "bounced",
        meta: { failedRecipient: bounce.failedRecipient },
      })
      .catch(() => {})
    await mailRepo.setThreadStatus(thread.id, "bounced").catch(() => {})
  }

  // 2. Flag the contact + re-open discovery for its jurisdiction when the failed recipient is a known
  // jurisdiction_contacts address. markContactBounced is a no-op for an unknown address; the discovery
  // re-open enqueues the same `jurisdiction.discovery` job the report-create path uses (singletonKey =
  // geoid, idempotent), keyed off the thread's jurisdiction when known.
  if (bounce.failedRecipient !== null) {
    const sql = container.getDb().sql
    await markBouncedContact(sql, bounce.failedRecipient).catch(() => {})
    const geoid = thread?.jurisdictionGeoid ?? (await geoidForContact(sql, bounce.failedRecipient))
    if (geoid !== null) {
      const data: JurisdictionDiscoveryJob = { geoid }
      await container.jobs
        .enqueue(JURISDICTION_DISCOVERY_JOB, data, { singletonKey: geoid })
        .catch(() => {})
    }
  }
}

/** Stamp bounced_at on every jurisdiction_contacts row carrying the address (the directory 'bounced' flag). */
async function markBouncedContact(sql: Sql, email: string): Promise<void> {
  await sql`UPDATE jurisdiction_contacts SET bounced_at = now() WHERE email = ${email}`
}

/** Resolve the geoid of a jurisdiction_contacts row by its email (to re-open discovery), or null. */
async function geoidForContact(sql: Sql, email: string): Promise<string | null> {
  const rows = await sql<{ geoid: string }[]>`
    SELECT geoid FROM jurisdiction_contacts WHERE email = ${email} LIMIT 1
  `
  return rows[0]?.geoid ?? null
}

/** Pull the first email address out of a free-text fragment (a header value or a DSN line), or null. */
function extractEmail(value: string | null): string | null {
  if (value === null) return null
  const m = value.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
  return m ? m[0] : null
}

/** Return the first capture group of a line-regex match against the body, or null. */
function matchLine(body: string, re: RegExp): string | null {
  const m = body.match(re)
  return m && m[1] ? m[1].trim() : null
}

/** Extract a bracketed `<id@host>` Message-ID from a fragment (the value after a Message-ID: line), or null. */
function matchBracketId(value: string | null): string | null {
  if (value === null) return null
  const m = value.match(/<[^>]+>/)
  return m ? m[0] : value.trim().length > 0 ? value.trim() : null
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
