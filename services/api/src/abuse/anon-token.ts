/**
 * Anonymous reporting token: a signed, short-lived credential that lets a logged-out reporter submit a
 * bounded number of reports and later claim them into an account.
 *
 * Wire form `"<tokenId>.<hmac>"`: tokenId is 256 bits of CSPRNG entropy and the anon_tokens primary key,
 * hmac is HMAC-SHA256(ANON_TOKEN_SIGNING_KEY, tokenId). The HMAC makes the token unforgeable, but it only
 * authenticates server-side state: the row still decides expiry, report_count and flagged, so the token
 * never carries authority by itself.
 *
 * The per-token cap is enforced against report_count, which anon-service bumps in the same transaction
 * that creates the report, so a crashed submit cannot leak quota.
 */

import { createHmac } from "node:crypto"
import { AppError } from "@civfix/shared"
import { generateToken, constantTimeStringEqual } from "../auth/crypto.js"

export const ANON_TOKEN_TTL_SECONDS = 24 * 60 * 60

export const ANON_TOKEN_REPORT_CAP = 5

export const ANON_REPORT_CAP_MESSAGE =
  "This anonymous session has reached its report limit. Sign in to continue."

/** base64url never contains ".", so the separator cannot collide with the id or the HMAC. */
const TOKEN_SEP = "."

function hmac(tokenId: string, signingKey: string): string {
  return createHmac("sha256", signingKey).update(tokenId).digest("base64url")
}

export function signAnonToken(tokenId: string, signingKey: string): string {
  return `${tokenId}${TOKEN_SEP}${hmac(tokenId, signingKey)}`
}

/**
 * Only proves the token was minted by us. Expiry and the cap live on the row, which the caller loads.
 */
export function verifyAnonTokenSignature(token: string, signingKey: string): string | null {
  const idx = token.indexOf(TOKEN_SEP)
  if (idx <= 0 || idx === token.length - 1) return null
  const tokenId = token.slice(0, idx)
  const sig = token.slice(idx + 1)
  const expected = hmac(tokenId, signingKey)
  return constantTimeStringEqual(sig, expected) ? tokenId : null
}

export interface AnonTokenRecord {
  id: string
  createdAt: Date
  expiresAt: Date
  reportCount: number
  flagged: boolean
  claimCode: string | null
}

export interface AnonTokenStore {
  insert(row: AnonTokenRecord): Promise<void>
  findById(id: string): Promise<AnonTokenRecord | null>
}

export interface AnonTokenDeps {
  store: AnonTokenStore
  signingKey: string
  newId?: () => string
  now?: () => Date
}

export interface IssuedAnonToken {
  token: string
  /** Its id becomes the report's anon_session_id. */
  record: AnonTokenRecord
}

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
 * Leaves the report cap to `assertUnderReportCap` so the caller controls ordering, and still resolves a
 * flagged row: policy on flagged tokens belongs to the caller.
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

export function assertUnderReportCap(
  row: AnonTokenRecord,
  cap: number = ANON_TOKEN_REPORT_CAP,
): { remaining: number } {
  if (row.reportCount >= cap) {
    throw AppError.rateLimited(ANON_REPORT_CAP_MESSAGE)
  }
  return { remaining: cap - row.reportCount }
}

/**
 * Split out of resolveOrIssueAnonToken because anon-service must resolve the presented token before its
 * idempotency lookup (the stored idempotency row is owner-scoped by the token id) and must not re-read
 * or re-issue the row afterwards.
 */
export async function ensureAnonToken(
  existing: AnonTokenRecord | null,
  deps: AnonTokenDeps,
): Promise<{ record: AnonTokenRecord; issuedToken?: string }> {
  if (existing) {
    assertUnderReportCap(existing)
    return { record: existing }
  }
  const issued = await issueAnonToken(deps)
  return { record: issued.record, issuedToken: issued.token }
}

export async function resolveOrIssueAnonToken(
  presented: string | undefined | null,
  deps: AnonTokenDeps,
): Promise<{ record: AnonTokenRecord; issuedToken?: string }> {
  return ensureAnonToken(await resolveAnonToken(presented, deps), deps)
}
