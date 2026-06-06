/**
 * Inbound mail webhook (Phase 2). SERVER-SIDE ingress for the Cloudflare Email Routing -> Workers
 * parser that forwards municipal replies. This route lives OUTSIDE /admin and is NOT operator-gated:
 * it is authenticated by the shared CF_EMAIL_WEBHOOK_SECRET, not an operator session.
 *
 *   POST /webhooks/inbound-mail  authenticate the Cloudflare worker via the shared secret header, then
 *                                parse the RFC822 body, resolve the thread by reply+{token}, write the
 *                                inbound mail_messages row, stream any attachments to R2, record a
 *                                mail_events row, and mark the thread unread. Returns 202.
 *
 * PIPELINE (after the constant-time secret check):
 *   1. container.inboundMail.parse(raw) -> ParsedMail (from / to / subject / text / headers / ...).
 *   2. container.inboundMail.extractThreadToken(mail) -> the reply+{token} thread token (or null).
 *   3. upsertThreadByToken(token): find the existing outbound thread the reply belongs to, or create a
 *      new one when the token is unknown (a stray inbound). The existing thread keeps its
 *      jurisdiction_geoid (upsert init is ignored on a hit); a brand-new thread has none derivable from
 *      the raw mail, so it is null.
 *   4. insertMessage(direction:'in', ...): persists the inbound message AND (in the repo) bumps
 *      last_message_at + sets the thread unread, which is the "mark unread" step.
 *   5. stream any attachments to R2 via container.storage and store { key, filename, size } on the
 *      message. An OVER-SIZE attachment is NOT streamed: the message body + headers are still preserved
 *      and the event meta is flagged (oversizeAttachments) so the operator can chase the original.
 *   6. recordEvent(type:'delivered'): an inbound reply is the strongest possible proof the prior
 *      outbound reached a human, so it is recorded as a 'delivered' deliverability signal (the
 *      mail_events.type CHECK admits only sent/delivered/bounced/complained/opened); the meta marks it
 *      inbound-derived so it is never confused with an OCI delivery callback.
 *   7. 202 Accepted so the Cloudflare worker does not retry.
 *
 * SAFETY: a malformed body / missing token / parse failure NEVER 5xx-loops the worker. The handler
 * acknowledges with 202 (recording why it could not thread, when a thread context exists) so a poisoned
 * message is dropped rather than retried forever. Only an UNAUTHENTICATED call is rejected (401).
 */

import { AppError } from "@civfix/shared"
import type { MailAttachment, ParsedMail } from "@civfix/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Container } from "../../di.js"
import { constantTimeStringEqual } from "../../auth/crypto.js"
import {
  makeDrizzleMailRepository,
  type InsertMessageInput,
  type MailRepository,
} from "../../services/admin/mail-repository.drizzle.js"
import type { Storage } from "@civfix/shared/interfaces"

/** Header the Cloudflare Email worker sends the shared secret in. */
export const CF_WEBHOOK_SECRET_HEADER = "x-cf-webhook-secret"

/**
 * Max attachment size (bytes) we stream into R2 from an inbound message. Anything larger is preserved by
 * reference (the message + headers are still stored; the event meta flags it) rather than buffered into
 * object storage. Generous enough for typical municipal PDFs / photos.
 */
export const INBOUND_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

/**
 * Optional injected inbound-mail dependencies (tests). When present the webhook uses these (an in-memory
 * mail repo + a fake Storage) instead of the container's DB-backed repo, so the whole pipeline runs
 * offline. The InboundMail + the secret are still taken from the container (its fake parser + env).
 */
export interface InboundMailWebhookOverrides {
  repo: MailRepository
  storage: Storage
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected inbound-mail webhook overrides (tests). See InboundMailWebhookOverrides. */
    inboundMailOverrides?: InboundMailWebhookOverrides
  }
}

/**
 * A single inbound attachment as a richer parser might surface it. The Phase 2 InboundMail seam's
 * ParsedMail does not yet model attachments (it is documented "minimal shape for now"), so this is read
 * defensively off the parsed object: when present, each entry streams to R2; when absent, the message
 * simply lands with no attachments. Declared locally so we never widen the shared interface here.
 */
interface ParsedAttachment {
  filename?: string
  content?: Uint8Array
  size?: number
  contentType?: string
}

/**
 * Register the inbound-mail webhook. Mounted unconditionally from routes/index.ts (it needs no auth
 * bundle), but it ONLY accepts requests presenting the configured CF_EMAIL_WEBHOOK_SECRET. When the
 * secret is NOT configured the route is effectively closed (every call is unauthorized), so a
 * misconfigured deploy cannot accept forged inbound mail.
 */
export async function registerInboundMailWebhook(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const expectedSecret = container.env.CF_EMAIL_WEBHOOK_SECRET

  // Register the route inside an ENCAPSULATED child context so the raw-body content-type parser below is
  // confined to this webhook and never changes how the rest of the API parses bodies. The Cloudflare
  // worker posts the raw RFC822 message (message/rfc822 / text/plain / octet-stream); we buffer it to a
  // Uint8Array for container.inboundMail.parse. JSON posts still parse via the inherited default parser.
  await app.register(async (scope) => {
    const rawParser = (
      _req: FastifyRequest,
      payload: Buffer,
      done: (err: Error | null, body?: unknown) => void,
    ): void => {
      done(null, payload)
    }
    scope.addContentTypeParser("message/rfc822", { parseAs: "buffer" }, rawParser)
    scope.addContentTypeParser("text/plain", { parseAs: "buffer" }, rawParser)
    scope.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, rawParser)

    scope.post("/webhooks/inbound-mail", async (request, reply) => {
      // Pass the ROOT app (closure) so resolveDeps reads inboundMailOverrides off the instance the test
      // decorated, not the encapsulated child scope.
      await handleInbound(request, reply, container, app, expectedSecret)
    })
  })
}

/** The inbound-mail pipeline body, factored out so the encapsulated scope's route stays a one-liner. */
async function handleInbound(
  request: FastifyRequest,
  reply: FastifyReply,
  container: Container,
  app: FastifyInstance,
  expectedSecret: string | undefined,
): Promise<void> {
  assertWebhookSecret(request, expectedSecret)

  const raw = rawBody(request)
  if (raw === null) {
    // No usable body: acknowledge (do not retry) but do nothing.
    return ack(reply, { threaded: false, reason: "empty-body" })
  }

  const { repo, storage } = resolveDeps(app, container)

  // PARSE. A parser failure must NOT loop the worker: acknowledge and drop.
  let mail: ParsedMail
  try {
    mail = await container.inboundMail.parse(raw)
  } catch {
    return ack(reply, { threaded: false, reason: "parse-failed" })
  }

  // THREAD TOKEN. Without one we cannot thread; acknowledge and drop (a stray, non-reply message).
  let token: string | null
  try {
    token = container.inboundMail.extractThreadToken(mail)
  } catch {
    token = null
  }
  if (token === null || token.length === 0) {
    return ack(reply, { threaded: false, reason: "no-thread-token" })
  }

  // UPSERT THREAD. The existing outbound thread keeps its jurisdiction_geoid (init is ignored on a
  // hit); an unknown token mints a fresh thread so the inbound reply is never lost.
  const thread = await repo.upsertThreadByToken(token, {
    subject: mail.subject ?? undefined,
  })

  // ATTACHMENTS -> R2. Best-effort: an over-size or un-storable attachment never fails the ingest.
  const { attachments, oversize } = await streamAttachments(storage, thread.id, mail)

  // INSERT the inbound message. The repo bumps last_message_at + sets the thread UNREAD for an inbound
  // direction, which is the "mark unread" step.
  const insert: InsertMessageInput = {
    threadId: thread.id,
    direction: "in",
    fromAddr: mail.from?.address ?? null,
    toAddr: mail.to[0]?.address ?? null,
    subject: mail.subject ?? null,
    body: mail.text ?? mail.html ?? null,
    attachments,
    messageId: mail.messageId ?? null,
    inReplyTo: mail.inReplyTo ?? null,
  }
  const message = await repo.insertMessage(insert)

  // RECORD a deliverability event. An inbound reply proves the prior outbound was delivered; the meta
  // marks it inbound-derived (and flags any preserved over-size attachments).
  await repo.recordEvent({
    threadId: thread.id,
    messageId: message.id,
    type: "delivered",
    meta: {
      direction: "in",
      from: mail.from?.address ?? null,
      messageId: mail.messageId ?? null,
      ...(oversize.length > 0 ? { oversizeAttachments: oversize } : {}),
    },
  })

  return ack(reply, { threaded: true, threadId: thread.id, messageId: message.id })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the repo + storage from a test override or the container (DB-backed repo + R2). */
function resolveDeps(
  app: FastifyInstance,
  container: Container,
): { repo: MailRepository; storage: Storage } {
  const overrides = app.inboundMailOverrides
  if (overrides) return { repo: overrides.repo, storage: overrides.storage }
  return { repo: makeDrizzleMailRepository(container.getDb().sql), storage: container.storage }
}

/**
 * Authenticate the webhook against the shared secret using a constant-time compare. Throws
 * AppError.unauthorized when the secret is unset (route closed) or the presented header does not match.
 */
function assertWebhookSecret(request: FastifyRequest, expectedSecret: string | undefined): void {
  if (!expectedSecret) {
    // No secret configured: refuse rather than accept unauthenticated inbound mail.
    throw AppError.unauthorized("Inbound mail webhook is not configured.")
  }
  const raw = request.headers[CF_WEBHOOK_SECRET_HEADER]
  const presented = Array.isArray(raw) ? raw[0] : raw
  if (!presented || !constantTimeStringEqual(presented, expectedSecret)) {
    throw AppError.unauthorized("Invalid inbound mail webhook secret.")
  }
}

/**
 * Coerce the request body to the raw RFC822 bytes the parser consumes. Accepts a Buffer/Uint8Array (the
 * worker posts the raw message), or a string (decoded to UTF-8). Returns null when there is nothing to
 * parse, so the handler can acknowledge without invoking the parser on junk.
 */
function rawBody(request: FastifyRequest): Uint8Array | null {
  const body: unknown = request.body
  if (body == null) return null
  if (body instanceof Uint8Array) return body.byteLength > 0 ? body : null
  if (typeof body === "string") {
    if (body.length === 0) return null
    return new TextEncoder().encode(body)
  }
  // Some content-type parsers hand back a Buffer-like { data } or an object; stringify defensively so a
  // structured post still reaches the (RFC822-tolerant) parser rather than 500ing here.
  if (typeof body === "object") {
    try {
      const text = JSON.stringify(body)
      return text.length > 0 ? new TextEncoder().encode(text) : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Stream any parsed attachments into R2, returning the stored {key, filename, size} refs plus the names
 * of any that were too large to store (preserved by reference, flagged on the event). The Phase 2
 * InboundMail seam does not surface attachments, so this is a no-op (empty) for the current parser; it is
 * structured so a richer parser that adds `attachments` to ParsedMail streams them without a route change.
 */
async function streamAttachments(
  storage: Storage,
  threadId: string,
  mail: ParsedMail,
): Promise<{ attachments: MailAttachment[]; oversize: string[] }> {
  const parsed = readParsedAttachments(mail)
  const attachments: MailAttachment[] = []
  const oversize: string[] = []
  let index = 0
  for (const att of parsed) {
    const filename = att.filename && att.filename.length > 0 ? att.filename : `attachment-${index}`
    const bytes = att.content ?? null
    const size = att.size ?? bytes?.byteLength ?? 0
    index += 1

    // Over-size OR no bytes available: preserve the message, flag the attachment, do not store.
    if (size > INBOUND_ATTACHMENT_MAX_BYTES || bytes === null) {
      if (size > INBOUND_ATTACHMENT_MAX_BYTES) oversize.push(filename)
      continue
    }

    const key = `inbound-mail/${threadId}/${index}-${sanitizeFilename(filename)}`
    await storage.put(key, bytes, {
      ...(att.contentType !== undefined ? { contentType: att.contentType } : {}),
    })
    attachments.push({ key, filename, size: bytes.byteLength })
  }
  return { attachments, oversize }
}

/**
 * Defensively read an `attachments` array off the parsed mail. ParsedMail does not declare one (the seam
 * is minimal in Phase 2), so we probe structurally and ignore anything that is not a well-formed entry.
 */
function readParsedAttachments(mail: ParsedMail): ParsedAttachment[] {
  const maybe = (mail as unknown as { attachments?: unknown }).attachments
  if (!Array.isArray(maybe)) return []
  const out: ParsedAttachment[] = []
  for (const entry of maybe) {
    if (entry && typeof entry === "object") out.push(entry as ParsedAttachment)
  }
  return out
}

/** Reduce a filename to a safe object-key segment (no path separators / control chars). */
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "")
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "file"
}

/** Acknowledge receipt with 202 so the Cloudflare worker does not retry. Optionally echoes a reason. */
function ack(reply: FastifyReply, body: Record<string, unknown>): void {
  reply.status(202).send({ accepted: true, ...body })
}
