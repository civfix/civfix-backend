export interface Env {
  R2_BUCKET: R2Bucket
  BACKEND_WEBHOOK_URL: string
  CF_EMAIL_WEBHOOK_SECRET: string
}

const PENDING_PREFIX = "inbound/pending/"
const REJECT_STORE = "Temporary failure storing message; please retry."

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const rawBytes = await new Response(message.raw).arrayBuffer()

    const messageId = await deriveMessageId(message.headers, rawBytes)
    const key = await derivePendingKey(message.headers, rawBytes)

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

    ctx.waitUntil(nudgeBackend(env, key))
  },
}

const PENDING_SLUG_MAX_CHARS = 120
const PENDING_DIGEST_CHARS = 32

// The sender picks the Message-ID, so a key made from it alone lets a later mail (or a Message-ID
// that slugs alike) overwrite a pending .eml before the backend drains it; the content digest makes
// the key follow the bytes, while an identical redelivery still lands on the same key.
export async function derivePendingKey(headers: Headers, raw: ArrayBuffer): Promise<string> {
  const digest = await contentDigest(raw)
  const slug = slugify(headers.get("message-id") ?? "").slice(0, PENDING_SLUG_MAX_CHARS)
  const name = slug.length > 0 ? `${slug}.${digest.slice(0, PENDING_DIGEST_CHARS)}` : digest
  return `${PENDING_PREFIX}${name}.eml`
}

export async function deriveMessageId(headers: Headers, raw: ArrayBuffer): Promise<string> {
  const slug = slugify(headers.get("message-id") ?? "")
  return slug.length > 0 ? slug : contentDigest(raw)
}

async function contentDigest(raw: ArrayBuffer): Promise<string> {
  try {
    return await sha256Hex(raw)
  } catch {
    return crypto.randomUUID()
  }
}

export function slugify(messageId: string): string {
  return messageId
    .replace(/[<>]/g, "")
    .replace(/[^A-Za-z0-9._@-]+/g, "_")
    .slice(0, 200)
}

export async function nudgeBackend(env: Env, key: string): Promise<void> {
  const body = JSON.stringify({ key })
  const ts = Math.floor(Date.now() / 1000).toString()
  try {
    const signature = await hmacSha256Hex(env.CF_EMAIL_WEBHOOK_SECRET, `${ts}.${body}`)
    const res = await fetch(env.BACKEND_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cf-signature": signature,
        "x-cf-timestamp": ts,
      },
      body,
    })
    if (!res.ok) {
      console.error(
        `inbound nudge rejected: HTTP ${res.status} for ${key}; the backend sweep will pick it up`,
      )
    }
  } catch (err) {
    console.error(`inbound nudge failed for ${key}; the backend sweep will pick it up`, err)
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
