import { createHmac } from "node:crypto"
import { NotificationCategorySchema, type NotificationCategory } from "@civfix/contract"
import { constantTimeStringEqual } from "../auth/crypto.js"
import { MS_PER_DAY, MS_PER_SECOND } from "../lib/time.js"

// Signed with the broadcast unsubscribe key under its own prefix, which the HMAC covers, so neither
// verifier accepts the other's token (D10).
const NOTIFICATION_EMAIL_TOKEN_VERSION = "n1"
const TOKEN_PAYLOAD_VERSION = 1
const TOKEN_PART_COUNT = 3

const NOTIFICATION_EMAIL_TOKEN_TTL_DAYS = 400

export interface NotificationEmailCapability {
  userId: string
  category: NotificationCategory
  expiresAtMs: number
}

interface TokenPayload {
  v: 1
  i: string
  c: NotificationCategory
  x: number
}

export function mintNotificationEmailToken(
  capability: NotificationEmailCapability,
  signingKey: string,
): string {
  const payload: TokenPayload = {
    v: TOKEN_PAYLOAD_VERSION,
    i: capability.userId,
    c: capability.category,
    x: Math.floor(capability.expiresAtMs / MS_PER_SECOND),
  }
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  return `${NOTIFICATION_EMAIL_TOKEN_VERSION}.${body}.${sign(body, signingKey)}`
}

export function verifyNotificationEmailToken(
  token: string,
  signingKey: string,
  nowMs: number,
): NotificationEmailCapability | null {
  const parts = token.split(".")
  if (parts.length !== TOKEN_PART_COUNT) return null
  const [version, body, signature] = parts as [string, string, string]
  if (version !== NOTIFICATION_EMAIL_TOKEN_VERSION) return null
  if (body.length === 0 || signature.length === 0) return null
  if (!constantTimeStringEqual(signature, sign(body, signingKey))) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
  } catch {
    // Unreachable without the signing key; refused like any other bad token rather than a 500.
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const p = parsed as Record<string, unknown>
  if (p.v !== TOKEN_PAYLOAD_VERSION) return null
  if (typeof p.i !== "string" || p.i.length === 0) return null
  const category = NotificationCategorySchema.safeParse(p.c)
  if (!category.success) return null
  if (typeof p.x !== "number" || !Number.isFinite(p.x)) return null
  const expiresAtMs = p.x * MS_PER_SECOND
  if (expiresAtMs <= nowMs) return null

  return { userId: p.i, category: category.data, expiresAtMs }
}

export function notificationEmailExpiryFrom(sentAtMs: number): number {
  return sentAtMs + NOTIFICATION_EMAIL_TOKEN_TTL_DAYS * MS_PER_DAY
}

function sign(body: string, signingKey: string): string {
  return createHmac("sha256", signingKey)
    .update(`${NOTIFICATION_EMAIL_TOKEN_VERSION}.${body}`)
    .digest("base64url")
}
