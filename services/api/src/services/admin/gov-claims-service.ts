// The DTO's verified[]/pending[] arrays are derived from the stored `checks` map (an absent check is
// pending), so the row pills always reflect it. The approved claim row IS the user<->jurisdiction binding
// (gov_claims.jurisdiction_geoid); there is no separate membership table.

import { AppError, relativeAgo } from "@civfix/shared"
import { applyRoleChange, type RevokeAllSessions } from "./role-change.js"
import { newAccountDisplayName } from "../../auth/official-account.js"
import type {
  GovCheck,
  GovCheckStatus,
  GovChecks,
  GovClaimDTO,
  GovClaimListQuery,
  GovClaimListResponse,
  GovVerificationCheck,
  Role,
} from "@civfix/shared"
import { clampLimit } from "./pagination.js"
import type {
  GovCheckRecord,
  GovClaimRecord,
  GovClaimSort,
  GovClaimsRepository,
  ListGovClaimsArgs,
} from "./gov-claims-repository.js"

/** Display order. */
export const GOV_CHECKS: readonly GovVerificationCheck[] = ["linkedin", "directory", "callback"]

const GOV_ADMIN_ROLE: Role = "gov_admin"

/** Approving a claim must never re-role an operator account. */
const OPERATOR_ROLE: Role = "operator"

const GOV_CLAIM_NOT_FOUND = "Gov claim not found"
const GOV_CLAIM_NOT_PENDING = "Gov claim is not pending"

function parseGovClaimSort(sort: string | undefined): GovClaimSort {
  return sort === "oldest" ? "oldest" : "newest"
}

export interface ProvisionedUser {
  id: string
  email: string | null
  role: string
  /** The owner has proven control of `email` (Email-OTP or verified OAuth). */
  emailVerified: boolean
}

export interface UserProvisioner {
  findByEmail(email: string): Promise<ProvisionedUser | null>
  create(email: string, displayName: string): Promise<ProvisionedUser>
  setRole(id: string, role: Role): Promise<ProvisionedUser>
}

export function toChecksDTO(
  checks: Partial<Record<GovVerificationCheck, GovCheckRecord>>,
): GovChecks {
  const one = (check: GovVerificationCheck): GovCheck => {
    const stored = checks[check]
    return {
      status: stored?.status ?? "pending",
      evidence: stored?.evidence ?? null,
      note: stored?.note ?? null,
    }
  }
  return { linkedin: one("linkedin"), directory: one("directory"), callback: one("callback") }
}

export function verifiedChecks(
  checks: Partial<Record<GovVerificationCheck, GovCheckRecord>>,
): GovVerificationCheck[] {
  return GOV_CHECKS.filter((c) => checks[c]?.status === "verified")
}

export function pendingChecks(
  checks: Partial<Record<GovVerificationCheck, GovCheckRecord>>,
): GovVerificationCheck[] {
  return GOV_CHECKS.filter((c) => (checks[c]?.status ?? "pending") === "pending")
}

export interface GovClaimsServiceDeps {
  repo: GovClaimsRepository
  users: UserProvisioner
  /**
   * Required: a warm session serves the role baked into its Redis projection, and sliding expiry lets it
   * do so indefinitely. See role-change.ts.
   */
  revokeSessions: RevokeAllSessions
  now?: () => Date
}

/**
 * `actorId` is non-null here because each of these writes an audit row for a privilege decision that must
 * be attributable. The repository keeps a nullable slot because `insertAuditRow` accepts a system actor.
 */
export interface GovClaimsService {
  list(query: GovClaimListQuery): Promise<GovClaimListResponse>
  getClaim(id: string): Promise<GovClaimDTO>
  verify(
    id: string,
    input: {
      check: GovVerificationCheck
      status: GovCheckStatus
      evidence: string | null
      note: string | null
      actorId: string
    },
  ): Promise<void>
  approve(id: string, input: { actorId: string; note: string | null }): Promise<void>
  reject(id: string, input: { reason: string; actorId: string }): Promise<void>
}

export function makeGovClaimsService(deps: GovClaimsServiceDeps): GovClaimsService {
  const now = deps.now ?? (() => new Date())

  function toDTO(record: GovClaimRecord, ref: Date): GovClaimDTO {
    return {
      id: record.id,
      name: record.name,
      // The strict DTO requires non-null title/org/contactEmail, so a missing field degrades to "".
      title: record.title ?? "",
      org: record.org ?? "",
      jurisdictionGeoid: record.jurisdictionGeoid,
      method: record.method,
      status: record.status,
      age: relativeAgo(record.createdAt, ref),
      contactEmail: record.contactEmail ?? "",
      verified: verifiedChecks(record.checks),
      pending: pendingChecks(record.checks),
      checks: toChecksDTO(record.checks),
    }
  }

  // A null write result covers both a missing claim and a decided one; re-reading lets an operator racing
  // a colleague's decision get a conflict, not "not found".
  async function throwMissingOrDecided(id: string): Promise<never> {
    const claim = await deps.repo.getClaim(id)
    if (!claim) throw AppError.notFound(GOV_CLAIM_NOT_FOUND)
    throw AppError.conflict(GOV_CLAIM_NOT_PENDING)
  }

  // Find-or-create carries no privilege, so it runs before the claim transition commits.
  async function findOrCreateClaimUser(email: string, claimName: string): Promise<ProvisionedUser> {
    const user = await deps.users.findByEmail(email)
    if (!user) {
      // The placeholder's email is unverified: it has no sessions and only becomes usable when the real
      // owner signs in via Email-OTP, which proves control of the address.
      return deps.users.create(email, newAccountDisplayName(claimName, "citizen"))
    }
    // Security: contact_email is unverified free text. Elevating a pre-existing account whose email
    // is not verified would let a duped or compromised operator elevate an arbitrary victim account
    // by entering its address.
    if (!user.emailVerified) {
      throw AppError.validation(
        { contactEmail: "unverified" },
        "Cannot elevate an existing account whose email is not verified",
      )
    }
    // Same rule as the users console's setRole: an operator account is not changeable from the
    // console. Otherwise a claim carrying an operator's address would demote them and revoke their
    // sessions, one operator stripping another through the gov queue. Operator authority is governed
    // by ADMIN_EMAILS + Cloudflare Access.
    if (user.role === OPERATOR_ROLE) {
      throw AppError.forbidden(
        "Operator accounts are managed through ADMIN_EMAILS; they cannot be changed from the console.",
      )
    }
    return user
  }

  return {
    async list(query: GovClaimListQuery): Promise<GovClaimListResponse> {
      const ref = now()
      const args: ListGovClaimsArgs = {
        q: query.q && query.q.trim() !== "" ? query.q.trim() : null,
        filter: query.filter ?? "pending",
        sort: parseGovClaimSort(query.sort),
        cursor: query.cursor ?? null,
        limit: clampLimit(query.limit),
      }
      const { records, nextCursor } = await deps.repo.list(args)
      return { items: records.map((r) => toDTO(r, ref)), nextCursor }
    },

    async getClaim(id: string): Promise<GovClaimDTO> {
      const ref = now()
      const record = await deps.repo.getClaim(id)
      if (!record) throw AppError.notFound(GOV_CLAIM_NOT_FOUND)
      return toDTO(record, ref)
    },

    async verify(
      id: string,
      input: {
        check: GovVerificationCheck
        status: GovCheckStatus
        evidence: string | null
        note: string | null
        actorId: string
      },
    ): Promise<void> {
      const updated = await deps.repo.setCheck(id, input)
      if (!updated) await throwMissingOrDecided(id)
    },

    async approve(id: string, input: { actorId: string; note: string | null }): Promise<void> {
      const claim = await deps.repo.getClaim(id)
      if (!claim) throw AppError.notFound(GOV_CLAIM_NOT_FOUND)
      if (claim.status !== "pending") {
        throw AppError.conflict(GOV_CLAIM_NOT_PENDING)
      }
      const email = claim.contactEmail?.trim()
      if (!email) {
        throw AppError.validation(
          { contactEmail: "required" },
          "Cannot approve a gov claim without a contact email",
        )
      }

      // The privilege grant happens only after the claim transition commits, so a concurrent decision or
      // a failed transition never leaves a gov_admin elevation with no approved claim to justify it.
      const user = await findOrCreateClaimUser(email, claim.name)

      const updated = await deps.repo.approve(id, {
        userId: user.id,
        actorId: input.actorId,
        note: input.note,
      })
      if (!updated) {
        // A concurrent decision won. The user has not been elevated, so there is nothing to compensate.
        throw AppError.conflict(GOV_CLAIM_NOT_PENDING)
      }

      // A failure from here on leaves the claim approved without the role, the recoverable direction:
      // the role can be re-granted. applyRoleChange always revokes the user's sessions, which escalation
      // needs too: live sessions carry the old role in the Redis projection and sliding expiry keeps them
      // alive indefinitely.
      if (user.role !== GOV_ADMIN_ROLE) {
        await applyRoleChange(
          {
            write: async (userId, role) => {
              await deps.users.setRole(userId, role)
            },
            revokeAll: deps.revokeSessions,
          },
          user.id,
          GOV_ADMIN_ROLE,
        )
      }
    },

    async reject(id: string, input: { reason: string; actorId: string }): Promise<void> {
      const updated = await deps.repo.reject(id, input)
      if (!updated) await throwMissingOrDecided(id)
    },
  }
}
