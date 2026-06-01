/**
 * Anonymous reporting token: a signed, short-lived credential that lets a logged-out reporter submit a
 * bounded number of reports and later claim them into an account.
 *
 * Shape on the wire: `"<tokenId>.<hmac>"` where
 *   - tokenId is 256 bits of CSPRNG entropy (base64url), the PRIMARY KEY of an anon_tokens row, and
 *   - hmac is HMAC-SHA256(ANON_TOKEN_SIGNING_KEY, tokenId), base64url.
 * The HMAC makes the token UNFORGEABLE: a client cannot mint a tokenId that references a row without
 * the server's signing key. The server still loads the row to enforce per-token state (report_count,
 * expiry, flagged), so the token is a stateless authenticator over server-side state - it is never a
 * bearer of authority by itself.
 *
 * LIFETIME: 24h (ANON_TOKEN_TTL_SECONDS), stamped on the row's expires_at at issue time. An expired or
 * missing row makes the token invalid even if the HMAC checks out.
 *
 * PER-TOKEN CAP: a token may back at most ANON_TOKEN_REPORT_CAP reports in its lifetime. The cap is
 * enforced against the row's report_count, which the anon-service bumps inside the same transaction
 * that creates the report (so a crashed submit cannot leak quota).
 *
 * ISSUANCE: on the first anon submit with no valid token presented, the service calls `issueAnonToken`
 * to create a row + return the signed token; the client stores it (cookie for web, body for mobile -
 * the transport is documented on the anon route) and sends it back as `anonToken` next time.
 *
 * The signing/verification is PURE (sign/verify/parse take the key as an argument); the row lifecycle
 * sits behind a small AnonTokenStore seam with an in-memory impl, so every behavior (issue, verify,
 * cap, expiry, claim-code) is unit-testable with no database.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import { AppError } from "@civfix/shared"
import { generateToken } from "../auth/crypto.js"

/** Anonymous token lifetime: 24 hours, in seconds. */
export const ANON_TOKEN_TTL_SECONDS = 24 * 60 * 60

/** Max reports a single anon token may back over its lifetime. */
export const ANON_TOKEN_REPORT_CAP = 5

/** Separator between the token id and its HMAC in the wire form. base64url never contains ".". */
const TOKEN_SEP = "."

// ---------------------------------------------------------------------------
// Pure signing / verification (key passed in; no IO)
// ---------------------------------------------------------------------------

/** HMAC-SHA256 of `tokenId` under `signingKey`, base64url-encoded. */
function hmac(tokenId: string, signingKey: string): string {
  return createHmac("sha256", signingKey).update(tokenId).digest("base64url")
}

/** Constant-time compare of two base64url HMAC strings (equal length expected; false otherwise). */
function hmacEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** Build the signed wire token for a token id. PURE. */
export function signAnonToken(tokenId: string, signingKey: string): string {
  return `${tokenId}${TOKEN_SEP}${hmac(tokenId, signingKey)}`
}

/**
 * Verify a presented wire token's signature and return its token id, or null when malformed / the HMAC
 * does not match. PURE. Does NOT consult the store (no expiry/cap check here) - this only proves the
 * token was minted by us. The caller loads the row to enforce state.
 */
export function verifyAnonTokenSignature(token: string, signingKey: string): string | null {
  const idx = token.indexOf(TOKEN_SEP)
  if (idx <= 0 || idx === token.length - 1) return null
  const tokenId = token.slice(0, idx)
  const sig = token.slice(idx + 1)
  const expected = hmac(tokenId, signingKey)
  return hmacEqual(sig, expected) ? tokenId : null
}

// ---------------------------------------------------------------------------
// Store seam (anon_tokens row lifecycle; faked in tests)
// ---------------------------------------------------------------------------

/** The anon_tokens row fields the abuse stack reads/writes. */
export interface AnonTokenRecord {
  id: string
  createdAt: Date
  expiresAt: Date
  reportCount: number
  flagged: boolean
  claimCode: string | null
}

/**
 * Persistence seam for anon_tokens. The production impl is Drizzle/Postgres; the offline tests pass an
 * in-memory implementation. Keeping the row lifecycle behind this interface is what makes the token
 * logic unit-testable with no DB.
 */
export interface AnonTokenStore {
  /** Insert a new anon_tokens row. */
  insert(row: AnonTokenRecord): Promise<void>
  /** Load a row by id, or null. */
  findById(id: string): Promise<AnonTokenRecord | null>
}

export interface AnonTokenDeps {
  store: AnonTokenStore
  signingKey: string
  /** Injectable id factory (defaults to a 256-bit base64url token). */
  newId?: () => string
  /** Injectable clock (defaults to Date.now). */
  now?: () => Date
}

/** The outcome of issuing a fresh anon token. */
export interface IssuedAnonToken {
  /** The signed wire token to hand back to the client. */
  token: string
  /** The persisted row (its id is the report's anon_session_id). */
  record: AnonTokenRecord
}

/**
 * Issue a brand-new anon token: mint a random id, persist an anon_tokens row (24h expiry, report_count
 * 0, not flagged, no claim code yet), and return the signed wire token + the row. Called on the first
 * anon submit when no valid token is presented.
 */
export async function issueAnonToken(deps: AnonTokenDeps): Promise<IssuedAnonToken> {
  const newId = deps.newId ?? (() => generateToken())
  const now = deps.now ?? (() => new Date())
  const at = now()
  const record: AnonTokenRecord = {
    id: newId(),
    createdAt: at,
    expiresAt: new Date(at.getTime() + ANON_TOKEN_TTL_SECONDS * 1000),
    reportCount: 0,
    flagged: false,
    claimCode: null,
  }
  await deps.store.insert(record)
  return { token: signAnonToken(record.id, deps.signingKey), record }
}

/**
 * Resolve a presented wire token to its valid, in-lifetime row. Returns null when the token is absent,
 * malformed, has a bad signature, references no row, or is expired. Does NOT enforce the report cap
 * (call `assertUnderReportCap` for that, so the caller can decide ordering). A flagged row still
 * resolves here; policy on flagged tokens is left to the caller.
 */
export async function resolveAnonToken(
  token: string | undefined | null,
  deps: AnonTokenDeps,
): Promise<AnonTokenRecord | null> {
  if (!token) return null
  const tokenId = verifyAnonTokenSignature(token, deps.signingKey)
  if (tokenId === null) return null
  const row = await deps.store.findById(tokenId)
  if (!row) return null
  const now = (deps.now ?? (() => new Date()))()
  if (row.expiresAt.getTime() <= now.getTime()) return null
  return row
}

/**
 * Assert a resolved token row is still under the per-token report cap. Throws AppError.rateLimited
 * (429) once report_count has reached ANON_TOKEN_REPORT_CAP, so the (cap+1)-th submit on the same
 * token is rejected. Returns the remaining allowance for logging.
 */
export function assertUnderReportCap(
  row: AnonTokenRecord,
  cap: number = ANON_TOKEN_REPORT_CAP,
): { remaining: number } {
  if (row.reportCount >= cap) {
    throw AppError.rateLimited("This anonymous session has reached its report limit. Sign in to continue.")
  }
  return { remaining: cap - row.reportCount }
}

/**
 * Resolve OR issue an anon token, then enforce the per-token cap. The single entry point the
 * anon-service uses before creating a report:
 *   - a valid presented token resolves to its row (and must be under the cap);
 *   - an absent/invalid token causes a fresh one to be issued (which is trivially under the cap).
 * Returns the row to bind as anon_session_id plus, when freshly minted, the signed token to hand back
 * to the client (undefined when an existing token was reused, since the client already holds it).
 */
export async function resolveOrIssueAnonToken(
  presented: string | undefined | null,
  deps: AnonTokenDeps,
): Promise<{ record: AnonTokenRecord; issuedToken?: string }> {
  const existing = await resolveAnonToken(presented, deps)
  if (existing) {
    assertUnderReportCap(existing)
    return { record: existing }
  }
  const issued = await issueAnonToken(deps)
  assertUnderReportCap(issued.record)
  return { record: issued.record, issuedToken: issued.token }
}
