import type {
  GovCheckStatus,
  GovClaimStatus,
  GovMethod,
  GovVerificationCheck,
} from "@civfix/shared"

export interface GovCheckRecord {
  status: GovCheckStatus
  evidence: string | null
  note: string | null
}

export interface GovClaimRecord {
  id: string
  userId: string | null
  name: string
  title: string | null
  org: string | null
  jurisdictionGeoid: string | null
  method: GovMethod
  contactEmail: string | null
  status: GovClaimStatus
  checks: Partial<Record<GovVerificationCheck, GovCheckRecord>>
  rejectReason: string | null
  createdAt: Date
}

export type GovClaimFilter = "all" | GovClaimStatus

export type GovClaimSort = "newest" | "oldest"

export interface ListGovClaimsArgs {
  q: string | null
  filter: GovClaimFilter
  sort: GovClaimSort
  cursor: string | null
  limit: number
}

export interface GovClaimsRepository {
  list(args: ListGovClaimsArgs): Promise<{ records: GovClaimRecord[]; nextCursor: string | null }>
  getClaim(id: string): Promise<GovClaimRecord | null>
  /** Null when the claim does not exist or is no longer pending. */
  setCheck(
    id: string,
    input: {
      check: GovVerificationCheck
      status: GovCheckStatus
      evidence: string | null
      note: string | null
      actorId: string | null
    },
  ): Promise<GovClaimRecord | null>
  /**
   * Persists only the claim transition and the user link; provisioning and the role grant belong to the
   * service. Null when the claim does not exist or is not pending.
   */
  approve(
    id: string,
    input: { userId: string; actorId: string | null; note: string | null },
  ): Promise<GovClaimRecord | null>
  /** Null when the claim does not exist or is not pending. */
  reject(
    id: string,
    input: { reason: string; actorId: string | null },
  ): Promise<GovClaimRecord | null>
}
