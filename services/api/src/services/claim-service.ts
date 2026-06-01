/**
 * Account-claim service: turn an anonymously-submitted report into a signed-in user's report.
 *
 * claimNudge(anonToken): the post-submit prompt payload. Given a valid anon token, return the
 *   {claimCode, reportId} of the pending report tied to that token, so the client can show a "sign in
 *   to keep your report" nudge that, after sign-in, calls claimReport with the code.
 *
 * claimReport(claimCode, userId): find the anon report by its single-use claim code and link it to the
 *   user: set reporter_user_id = userId, mark the claim code consumed (single-use), and return the
 *   ReportDTO. An invalid / already-used code -> AppError.notFound (no enumeration).
 *
 *   anon_session_id choice (documented): we KEEP anon_session_id after a claim. It is an audit trail of
 *   which anon session originally authored the report (useful for abuse forensics) and is not exposed
 *   in any DTO. Clearing it would lose that linkage for no functional gain; reporter_user_id is the
 *   field that now governs ownership/visibility, and the consumed claim code prevents re-claiming.
 *
 * All DB access is behind ClaimRepository so the flow is unit-testable with an in-memory impl (no DB).
 * Rendering the claimed ReportDTO reuses the report service's getReport as the owner, so the DTO is
 * identical to what GET /reports/:id returns (single projection source).
 */

import { AppError } from "@civfix/shared"
import type { ClaimNudgeResponse, ClaimReportResponse, ReportDTO } from "@civfix/shared"
import {
  resolveAnonToken,
  type AnonTokenDeps,
  type AnonTokenStore,
} from "../abuse/anon-token.js"
import type { ReportOwner } from "./report-service.js"

/** A pending anon report tied to a token, surfaced for the claim nudge. */
export interface PendingAnonReport {
  reportId: string
  claimCode: string
}

/**
 * Persistence seam for the claim flow. Extends the anon_tokens store (to resolve the token for the
 * nudge) with claim-by-code linking. Production impl is Drizzle/Postgres; tests pass an in-memory impl.
 */
export interface ClaimRepository extends AnonTokenStore {
  /** The pending (held or published) anon report tied to a token id, via its stamped claim code; null if none. */
  findPendingByTokenId(tokenId: string): Promise<PendingAnonReport | null>
  /**
   * Atomically claim the report carrying `claimCode` for `userId`: set reporter_user_id = userId and
   * mark the claim code consumed (single-use). Returns the claimed report id, or null when the code is
   * unknown OR already consumed (so the caller 404s without revealing which). Keeps anon_session_id.
   */
  claimByCode(claimCode: string, userId: string): Promise<{ reportId: string } | null>
}

export interface ClaimServiceDeps {
  repo: ClaimRepository
  /** ANON_TOKEN_SIGNING_KEY, to verify the anon token presented to claimNudge. */
  anonTokenSigningKey: string
  /** Render a ReportDTO for the now-owner. Wraps report-service.getReport so the projection matches. */
  getReportForOwner: (reportId: string, owner: ReportOwner) => Promise<ReportDTO>
  /** Injectable clock (defaults to Date.now) for anon-token expiry checks. */
  now?: () => Date
}

export interface ClaimService {
  claimNudge(anonToken: string): Promise<ClaimNudgeResponse>
  claimReport(claimCode: string, userId: string): Promise<ClaimReportResponse>
}

export function makeClaimService(deps: ClaimServiceDeps): ClaimService {
  const tokenDeps: AnonTokenDeps = {
    store: deps.repo,
    signingKey: deps.anonTokenSigningKey,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  }

  return {
    async claimNudge(anonToken: string): Promise<ClaimNudgeResponse> {
      // The token must be valid + in-lifetime to surface its pending report.
      const row = await resolveAnonToken(anonToken, tokenDeps)
      if (!row) {
        throw AppError.notFound("No pending report for this session")
      }
      const pending = await deps.repo.findPendingByTokenId(row.id)
      if (!pending) {
        throw AppError.notFound("No pending report for this session")
      }
      return { claimCode: pending.claimCode, reportId: pending.reportId }
    },

    async claimReport(claimCode: string, userId: string): Promise<ClaimReportResponse> {
      const claimed = await deps.repo.claimByCode(claimCode, userId)
      // Unknown OR already-used code -> NOT-FOUND (single-use; no enumeration of valid codes).
      if (!claimed) {
        throw AppError.notFound("Claim code not found")
      }
      // Render the report as its new owner so the DTO matches GET /reports/:id (mine=true).
      const report = await deps.getReportForOwner(claimed.reportId, { userId })
      return { report }
    },
  }
}
