import { createHmac } from "node:crypto"
import { constantTimeStringEqual } from "../../auth/crypto.js"

export const UNSUBSCRIBE_TOKEN_VERSION = "u1"

export const UNSUBSCRIBE_TOKEN_TTL_DAYS = 400

const SUBJECT_KINDS = ["user", "guest"] as const

export type UnsubscribeSubjectKind = (typeof SUBJECT_KINDS)[number]

export interface UnsubscribeCapability {
  subjectKind: UnsubscribeSubjectKind
  subjectId: string
  cleanupId: string
  expiresAtMs: number
}

interface TokenPayload {
  v: 1
  s: UnsubscribeSubjectKind
  i: string
  e: string
  x: number
}

export function mintUnsubscribeToken(
  capability: UnsubscribeCapability,
  signingKey: string,
): string {
  const payload: TokenPayload = {
    v: 1,
    s: capability.subjectKind,
    i: capability.subjectId,
    e: capability.cleanupId,
    x: Math.floor(capability.expiresAtMs / 1000),
  }
  const body = encode(JSON.stringify(payload))
  return `${UNSUBSCRIBE_TOKEN_VERSION}.${body}.${sign(body, signingKey)}`
}

export function verifyUnsubscribeToken(
  token: string,
  signingKey: string,
  nowMs: number,
): UnsubscribeCapability | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [version, body, signature] = parts as [string, string, string]
  if (version !== UNSUBSCRIBE_TOKEN_VERSION) return null
  if (body.length === 0 || signature.length === 0) return null
  if (!constantTimeStringEqual(signature, sign(body, signingKey))) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const p = parsed as Record<string, unknown>
  if (p.v !== 1) return null
  if (typeof p.s !== "string" || !(SUBJECT_KINDS as readonly string[]).includes(p.s)) return null
  if (typeof p.i !== "string" || p.i.length === 0) return null
  if (typeof p.e !== "string" || p.e.length === 0) return null
  if (typeof p.x !== "number" || !Number.isFinite(p.x)) return null
  const expiresAtMs = p.x * 1000
  if (expiresAtMs <= nowMs) return null

  return {
    subjectKind: p.s as UnsubscribeSubjectKind,
    subjectId: p.i,
    cleanupId: p.e,
    expiresAtMs,
  }
}

export function unsubscribeExpiryFrom(sentAtMs: number): number {
  return sentAtMs + UNSUBSCRIBE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

function sign(body: string, signingKey: string): string {
  return createHmac("sha256", signingKey).update(`${UNSUBSCRIBE_TOKEN_VERSION}.${body}`).digest("base64url")
}
