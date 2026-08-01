/**
 * Inbound mail webhook. SERVER-SIDE ingress for the Cloudflare Email Worker. Lives OUTSIDE /admin and is
 * NOT operator-gated: it is authenticated by an HMAC signature over the request body keyed with the
 * shared CF_EMAIL_WEBHOOK_SECRET.
 *
 *   POST /webhooks/inbound-mail   body { "key": "inbound/pending/<id>.eml" }, header x-cf-signature.
 *
 * The Worker has already written the raw .eml to R2; this webhook is a low-latency NUDGE carrying the
 * object key. We verify the HMAC, then hand the key to processInboundObject (the same processor the
 * boot/cron sweep uses): it fetches the bytes from R2, parses, routes a reply into mail_threads or a
 * catch-all message into inbound_emails (idempotent), and deletes the pending object. Returns 202.
 *
 * SAFETY: the webhook is a best-effort optimization — the R2 LIST sweep is the durable path. So a bad
 * key, a parse failure, or ANY processing error still ACKs 202 (never a 5xx retry loop); only an
 * UNAUTHENTICATED call (bad/missing signature, or an unconfigured secret) is rejected (401).
 *
 * HMAC contract (must match the Worker byte-for-byte): hex HMAC-SHA256 over the EXACT raw JSON body
 * bytes (`{"key":"..."}`, no whitespace), header `x-cf-signature`, key CF_EMAIL_WEBHOOK_SECRET. We
 * capture the raw body via a buffer content-type parser so the verified bytes are what the Worker signed.
 */

import { createHmac } from "node:crypto"
import { AppError } from "@civfix/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { perHost } from "../../plugins/rate-limit.js"
import type { Container } from "../../di.js"
import { constantTimeStringEqual } from "../../auth/crypto.js"
import {
  processInboundObject,
  INBOUND_PENDING_KEY_RE,
  type InboundProcessorDeps,
} from "../../services/admin/inbound-processor.js"

/** Header the Cloudflare Email Worker sends the hex HMAC-SHA256 signature in. */
export const CF_WEBHOOK_SIGNATURE_HEADER = "x-cf-signature"

/**
 * Header carrying the Unix-seconds timestamp the signature is bound to (L17).
 *
 * The original contract HMAC'd the body ALONE, with no timestamp and no nonce, so a captured
 * (body, signature) pair stayed valid forever — anyone who observed one nudge could replay it
 * indefinitely. Impact was bounded by message-id idempotency downstream, which is why this is a LOW,
 * but a signature with no expiry is still a credential with no expiry.
 *
 * The signed payload is now `<timestamp>.<raw body bytes>` and the timestamp must be inside
 * WEBHOOK_MAX_CLOCK_SKEW_SEC of now.
 */
export const CF_WEBHOOK_TIMESTAMP_HEADER = "x-cf-timestamp"

/** Accepted clock skew, in seconds, between the Worker and this server (±5 minutes). */
export const WEBHOOK_MAX_CLOCK_SKEW_SEC = 5 * 60

/**
 * Whether the legacy body-only signature (no timestamp header) is still accepted.
 *
 * ROLLOUT: the Cloudflare Email Worker lives in `infra/` and must be updated to send
 * `x-cf-timestamp` and sign `<timestamp>.<body>`. Until that ships, rejecting timestamp-less nudges
 * would break inbound mail entirely — so a timestamp-less request is accepted and LOGGED. Flip this to
 * `false` (and delete the branch) once the Worker is deployed; the R2 sweep is the durable path, so the
 * cutover is safe even if a nudge or two is dropped.
 */
export const ACCEPT_LEGACY_UNTIMESTAMPED_SIGNATURE = true

/**
 * Per-route limit: the route is unauthenticated-reachable (the HMAC is checked INSIDE the handler, after
 * the body is buffered + the HMAC computed), so a tight per-IP cap stops an attacker driving buffered-body
 * + HMAC work via the global 300/min. The Worker nudges at most a handful/sec.
 */
export const INBOUND_WEBHOOK_RATE_LIMIT = perHost({ max: 60, timeWindow: "1 minute" })

/**
 * The body is a tiny `{"key":"inbound/pending/<id>.eml"}` JSON object; cap it well under the global
 * bodyLimit so an oversized unauthenticated POST is rejected before it is buffered + HMAC'd.
 */
const INBOUND_WEBHOOK_BODY_LIMIT = 4096

/**
 * Optional injected processing seams (tests). When present the webhook passes them to
 * processInboundObject (an in-memory mail repo + in-memory inbound repo + a fake Storage + the fake
 * parser), so the whole pipeline runs offline with no DB and no R2.
 */
export type InboundMailWebhookOverrides = InboundProcessorDeps

declare module "fastify" {
  interface FastifyInstance {
    /** Injected inbound-mail webhook overrides (tests). See InboundMailWebhookOverrides. */
    inboundMailOverrides?: InboundMailWebhookOverrides
  }
}

/**
 * Register the inbound-mail webhook. Mounted unconditionally from routes/index.ts (it needs no auth
 * bundle), but it ONLY accepts requests whose body HMAC matches CF_EMAIL_WEBHOOK_SECRET. When the secret
 * is NOT configured the route is effectively closed (every call is unauthorized), so a misconfigured
 * deploy cannot accept forged inbound mail.
 */
export async function registerInboundMailWebhook(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const expectedSecret = container.env.CF_EMAIL_WEBHOOK_SECRET

  // Register inside an ENCAPSULATED child context so the raw-body parser is confined to this webhook and
  // never changes how the rest of the API parses JSON. We capture the EXACT bytes (parseAs: "buffer") so
  // the HMAC is verified over what the Worker signed, not a re-serialized object.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req: FastifyRequest, payload: Buffer, done: (err: Error | null, body?: unknown) => void) => {
        done(null, payload)
      },
    )

    scope.post(
      "/webhooks/inbound-mail",
      { bodyLimit: INBOUND_WEBHOOK_BODY_LIMIT, config: { rateLimit: INBOUND_WEBHOOK_RATE_LIMIT } },
      async (request, reply) => {
        // Pass the ROOT app (closure) so we read inboundMailOverrides off the instance tests decorated.
        await handleInbound(request, reply, container, app, expectedSecret)
      },
    )
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
  const rawBuf = request.body instanceof Buffer ? request.body : null
  assertSignature(request, rawBuf, expectedSecret)

  // Past auth: any further problem is ACKed (202), never retried — the sweep is the durable backstop.
  const key = readKey(rawBuf)
  if (key === null) return ack(reply, { processed: false, reason: "bad-key" })

  try {
    const deps = app.inboundMailOverrides ?? {}
    const result = await processInboundObject(container, key, deps)
    return ack(reply, { processed: result.outcome !== "skipped", outcome: result.outcome })
  } catch (err) {
    // Drop the nudge: the boot/cron sweep will reprocess the still-present pending object. Log it —
    // a recurring failure here (most often the R2 token lacking access to R2_INBOUND_BUCKET, i.e. a
    // 403 on getObject) would otherwise be invisible behind the always-202 contract.
    request.log.warn(
      { err, key },
      "inbound-mail webhook: processing failed (acked 202; sweep will retry)",
    )
    return ack(reply, { processed: false, reason: "error" })
  }
}

/**
 * Authenticate via HMAC. Throws AppError.unauthorized when the secret is unset (route closed), the body
 * is missing, the timestamp is outside the replay window, or the presented signature does not match
 * (constant-time compare).
 *
 * Signed payload (L17): `<x-cf-timestamp>.<raw body bytes>`. The timestamp is inside the MAC, so it
 * cannot be edited without invalidating the signature, and the freshness window is what bounds replay.
 * See ACCEPT_LEGACY_UNTIMESTAMPED_SIGNATURE for the transitional body-only path.
 */
export function assertSignature(
  request: FastifyRequest,
  rawBuf: Buffer | null,
  expectedSecret: string | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): void {
  if (!expectedSecret) {
    throw AppError.unauthorized("Inbound mail webhook is not configured.")
  }
  if (rawBuf === null) {
    throw AppError.unauthorized("Inbound mail webhook body missing.")
  }
  const header = request.headers[CF_WEBHOOK_SIGNATURE_HEADER]
  const presented = Array.isArray(header) ? header[0] : header
  if (!presented) {
    throw AppError.unauthorized("Invalid inbound mail webhook signature.")
  }

  const tsHeader = request.headers[CF_WEBHOOK_TIMESTAMP_HEADER]
  const rawTs = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader

  if (rawTs !== undefined && rawTs !== "") {
    // Freshness FIRST: a stale/garbage timestamp is rejected before any MAC comparison, so a replayed
    // pair never even reaches the compare.
    const ts = Number.parseInt(rawTs, 10)
    if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > WEBHOOK_MAX_CLOCK_SKEW_SEC) {
      throw AppError.unauthorized("Inbound mail webhook signature expired.")
    }
    const expected = createHmac("sha256", expectedSecret)
      .update(`${rawTs}.`)
      .update(rawBuf)
      .digest("hex")
    if (!constantTimeStringEqual(presented, expected)) {
      throw AppError.unauthorized("Invalid inbound mail webhook signature.")
    }
    return
  }

  if (!ACCEPT_LEGACY_UNTIMESTAMPED_SIGNATURE) {
    throw AppError.unauthorized("Inbound mail webhook signature is missing its timestamp.")
  }
  // TRANSITIONAL: body-only signature, replayable until the Worker ships the timestamp. Logged at warn
  // so the remaining legacy traffic is visible and the flag above can be flipped with confidence.
  request.log.warn("inbound-mail webhook: legacy untimestamped signature accepted (replayable)")
  const legacyExpected = createHmac("sha256", expectedSecret).update(rawBuf).digest("hex")
  if (!constantTimeStringEqual(presented, legacyExpected)) {
    throw AppError.unauthorized("Invalid inbound mail webhook signature.")
  }
}

/** Parse `{ key }` from the raw JSON body and validate it is a pending-prefix .eml key. */
function readKey(rawBuf: Buffer | null): string | null {
  if (rawBuf === null || rawBuf.byteLength === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBuf.toString("utf8"))
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const key = (parsed as { key?: unknown }).key
  if (typeof key !== "string" || !INBOUND_PENDING_KEY_RE.test(key)) return null
  return key
}

/** Acknowledge receipt with 202 so the Cloudflare Worker never retries. Optionally echoes detail. */
function ack(reply: FastifyReply, body: Record<string, unknown>): void {
  reply.status(202).send({ accepted: true, ...body })
}
