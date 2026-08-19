
export interface Env {
  R2_BUCKET: R2Bucket
  BACKEND_WEBHOOK_URL: string
  CF_EMAIL_WEBHOOK_SECRET: string
}

const PENDING_PREFIX = "inbound/pending/"
const REJECT_AUTH = "Rejected: message failed sender authentication (SPF/DKIM/DMARC)."
const REJECT_STORE = "Temporary failure storing message; please retry."

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    if (shouldReject(message.headers)) {
      message.setReject(REJECT_AUTH)
      return
    }

    const rawBytes = await new Response(message.raw).arrayBuffer()

    const messageId = await deriveMessageId(message.headers, rawBytes)
    const key = `${PENDING_PREFIX}${messageId}.eml`

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


export function shouldReject(headers: Headers): boolean {
  const ar = (headers.get("authentication-results") ?? "").toLowerCase()
  if (ar.length === 0) return false
  const dmarcFail = /dmarc=(fail|reject)/.test(ar)
  const spfFail = /spf=(fail|softfail|temperror|permerror)/.test(ar)
  const dkimFail = /dkim=(fail|temperror|permerror)/.test(ar)
  return dmarcFail || (spfFail && dkimFail)
}


export async function deriveMessageId(headers: Headers, raw: ArrayBuffer): Promise<string> {
  const slug = slugify(headers.get("message-id") ?? "")
  if (slug.length > 0) return slug
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


async function nudgeBackend(env: Env, key: string): Promise<void> {
  const body = JSON.stringify({ key })
  const ts = Math.floor(Date.now() / 1000).toString()
  const signature = await hmacSha256Hex(env.CF_EMAIL_WEBHOOK_SECRET, `${ts}.${body}`)
  try {
    await fetch(env.BACKEND_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cf-signature": signature,
        "x-cf-timestamp": ts,
      },
      body,
    })
  } catch {
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
