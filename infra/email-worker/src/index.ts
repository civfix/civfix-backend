/**
 * Cloudflare Email Worker — catch-all *@civfix.org inbound mail ingestion.
 *
 * Topology (see documents/17-inbound-email-worker.md):
 *   1. FILTER   reject spam / SPF-DKIM-DMARC failures (everything else is stored).
 *   2. CAPTURE  write the raw .eml to R2 at inbound/pending/<messageId>.eml — the SOURCE OF TRUTH.
 *               If the R2 put fails, setReject() so the sender's MTA retries (last-resort capture).
 *   3. NUDGE    best-effort HMAC-signed POST { key } to the backend webhook. Failure is HARMLESS:
 *               the backend reconciles inbound/pending/ on boot + a cron sweep, so the nudge is only
 *               a latency optimization.
 *
 * The Worker is deliberately dumb and fire-and-forget: no DB, no MIME parse, no retry loop. The backend
 * re-fetches the raw bytes from R2 and does the real parsing/routing/idempotency.
 *
 * Runtime caveats: in Workers Date.now()/Math.random() are constrained, so message ids use the
 * Message-ID header, else a SHA-256 of the raw bytes (so duplicate deliveries collide to one key),
 * else crypto.randomUUID(). new Date().toISOString() is fine for a metadata string.
 */

export interface Env {
  /** R2 binding -> the SAME physical bucket the backend reads (its R2_BUCKET). */
  R2_BUCKET: R2Bucket
  /** Backend webhook, e.g. https://api.civfix.org/webhooks/inbound-mail (must equal PUBLIC_API_URL + path). */
  BACKEND_WEBHOOK_URL: string
  /** Shared secret — identical VALUE to the backend's CF_EMAIL_WEBHOOK_SECRET (wrangler secret put). */
  CF_EMAIL_WEBHOOK_SECRET: string
}

const PENDING_PREFIX = "inbound/pending/"
const REJECT_AUTH = "Rejected: message failed sender authentication (SPF/DKIM/DMARC)."
const REJECT_STORE = "Temporary failure storing message; please retry."

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // 1) FILTER — reject only spam / auth failures. Cheap, before any R2 or network work.
    if (shouldReject(message.headers)) {
      message.setReject(REJECT_AUTH)
      return
    }

    // 2) Buffer the single-use raw stream ONCE (rawSize <= 25 MiB, so bounded).
    const rawBytes = await new Response(message.raw).arrayBuffer()

    // 3) Derive a STABLE messageId for the R2 key (the idempotency anchor the backend dedups on).
    const messageId = await deriveMessageId(message.headers, rawBytes)
    const key = `${PENDING_PREFIX}${messageId}.eml`

    // 4) CAPTURE to R2 — the source of truth. If THIS fails, setReject so the sender retries.
    try {
      await env.R2_BUCKET.put(key, rawBytes, {
        httpMetadata: { contentType: "message/rfc822" },
        customMetadata: {
          messageId,
          from: truncate(message.from, 320),
          to: truncate(message.to, 320),
          subject: truncate(message.headers.get("subject") ?? "", 200),
          receivedAt: new Date().toISOString(),
          rawSize: String(message.rawSize),
        },
      })
    } catch {
      message.setReject(REJECT_STORE)
      return
    }

    // 5) NUDGE the backend (latency optimization only). Runs after the response; failures swallowed.
    ctx.waitUntil(nudgeBackend(env, key))
  },
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Reject on a hard DMARC failure, or when BOTH SPF and DKIM fail. Cloudflare's upstream stamps an
 * Authentication-Results header before the Worker runs. No header -> store (fail-open on capture).
 */
export function shouldReject(headers: Headers): boolean {
  const ar = (headers.get("authentication-results") ?? "").toLowerCase()
  if (ar.length === 0) return false
  const dmarcFail = /dmarc=(fail|reject)/.test(ar)
  const spfFail = /spf=(fail|softfail|temperror|permerror)/.test(ar)
  const dkimFail = /dkim=(fail|temperror|permerror)/.test(ar)
  return dmarcFail || (spfFail && dkimFail)
}

// ---------------------------------------------------------------------------
// Stable message id
// ---------------------------------------------------------------------------

export async function deriveMessageId(headers: Headers, raw: ArrayBuffer): Promise<string> {
  const slug = slugify(headers.get("message-id") ?? "")
  if (slug.length > 0) return slug
  try {
    return await sha256Hex(raw) // same bytes -> same key, so re-deliveries dedupe even without Message-ID
  } catch {
    return crypto.randomUUID()
  }
}

/** Reduce a Message-ID to a safe object-key segment (strip angle brackets, cap length). */
export function slugify(messageId: string): string {
  return messageId
    .replace(/[<>]/g, "")
    .replace(/[^A-Za-z0-9._@-]+/g, "_")
    .slice(0, 200)
}

// ---------------------------------------------------------------------------
// Webhook nudge + HMAC (must match the backend verifier byte-for-byte)
// ---------------------------------------------------------------------------

async function nudgeBackend(env: Env, key: string): Promise<void> {
  const body = JSON.stringify({ key }) // sign EXACTLY these bytes; backend HMACs the raw request body
  const signature = await hmacSha256Hex(env.CF_EMAIL_WEBHOOK_SECRET, body)
  try {
    await fetch(env.BACKEND_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cf-signature": signature },
      body,
    })
    // A non-2xx is acceptable here: the backend LIST-sweep is the durable path.
  } catch {
    // Swallow: the webhook is a latency optimization only.
  }
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message))
  return toHex(sig)
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", buf))
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s
}
