import { AppError } from "@civfix/shared"
import type { ClaimNudgeResponse, ClaimReportResponse, ReportDTO } from "@civfix/shared"
import { resolveAnonToken, type AnonTokenDeps } from "../abuse/anon-token.js"
import type { ReportOwner } from "./report-service.js"
import { generateToken, sha256Hex } from "../auth/crypto.js"
import type { ClaimRepository } from "./anon-repository.js"

export interface ClaimServiceDeps {
  repo: ClaimRepository
  anonTokenSigningKey: string
  getReportForOwner: (reportId: string, owner: ReportOwner) => Promise<ReportDTO>
  enqueueHoldRelease?: (reportId: string) => Promise<void>
  newClaimCode?: () => string
  now?: () => Date
  logger?: { warn(obj: unknown, msg?: string): void }
}

export interface ClaimService {
  claimNudge(anonToken: string): Promise<ClaimNudgeResponse>
  claimReport(claimCode: string, userId: string): Promise<ClaimReportResponse>
}

export function makeClaimService(deps: ClaimServiceDeps): ClaimService {
  const newClaimCode = deps.newClaimCode ?? (() => generateToken())
  const tokenDeps: AnonTokenDeps = {
    store: deps.repo,
    signingKey: deps.anonTokenSigningKey,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  }

  return {
    async claimNudge(anonToken: string): Promise<ClaimNudgeResponse> {
      const row = await resolveAnonToken(anonToken, tokenDeps)
      if (!row) {
        throw AppError.notFound("No pending report for this session")
      }
      const claimCode = newClaimCode()
      const pending = await deps.repo.rotatePendingClaimCode(row.id, await sha256Hex(claimCode))
      if (!pending) {
        throw AppError.notFound("No pending report for this session")
      }
      return { claimCode, reportId: pending.reportId }
    },

    async claimReport(claimCode: string, userId: string): Promise<ClaimReportResponse> {
      const claimed = await deps.repo.claimByCode(await sha256Hex(claimCode), userId)
      if (!claimed) {
        throw AppError.notFound("Claim code not found")
      }
      if (deps.enqueueHoldRelease !== undefined) {
        // The claim already committed; the media-worker hold-release sweep is the backstop.
        await deps.enqueueHoldRelease(claimed.reportId).catch((err: unknown) => {
          deps.logger?.warn(
            { err, reportId: claimed.reportId },
            "claim: hold-release enqueue failed (suppressed; the sweep releases it)",
          )
        })
      }
      const report = await deps.getReportForOwner(claimed.reportId, { userId })
      return { report }
    },
  }
}
