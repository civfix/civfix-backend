/**
 * Verification service: the citizen-facing read of a user's "verified neighbor" status.
 *
 * Verification is no longer an in-app application. There are no documents, notes, or a submission/review
 * queue: a user gets verified by scheduling a call with the founder (an external scheduling link the UI
 * surfaces), and an operator marks the account verified afterward from the admin Users section. So the
 * only citizen endpoint left is GET /me/verification, which reports whether the viewer is verified.
 *
 * DB access sits behind the VerificationRepository seam (Drizzle impl in verification-repository.drizzle.ts),
 * so the service is unit-testable with no database. "verified" is the ABSENCE/PRESENCE of a
 * user_verification row with status='verified' (the table is otherwise untouched).
 */

import type { MyVerificationDTO } from "@civfix/shared"

// ---------------------------------------------------------------------------
// Repository seam (faked in tests)
// ---------------------------------------------------------------------------

export interface VerificationRepository {
  /** Whether the user has a `verified` user_verification row (drives the verified mark). */
  isVerified(userId: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface VerificationServiceDeps {
  repo: VerificationRepository
}

export interface VerificationService {
  getMine(userId: string): Promise<MyVerificationDTO>
}

export function makeVerificationService(deps: VerificationServiceDeps): VerificationService {
  return {
    async getMine(userId: string): Promise<MyVerificationDTO> {
      const verified = await deps.repo.isVerified(userId)
      return { status: verified ? "verified" : "unverified" }
    },
  }
}
