/**
 * Admin gov-provisioning service (Phase 2): the government onboarding queue.
 *
 * An applicant claims authority over a jurisdiction. The operator verifies up to three checks (LinkedIn
 * profile, municipal Directory listing, phone Callback), then either APPROVES (provision the gov user as
 * `gov_admin` and link the jurisdiction) or REJECTS (with a reason). The queue is fed by `gov_claims`
 * (pending rows). See enumeration 2.H + endpoints #36-#40.
 *
 * REPOSITORY SEAM: every read/write goes through GovClaimsRepository (Drizzle impl in
 * gov-claims-repository.drizzle.ts; an in-memory impl in gov-claims-repository.memory.ts for the offline
 * unit tests). The DTO PROJECTIONS (relative age, the verified[]/pending[] partition of the checks map)
 * live here and are pure + clock-injected.
 *
 * VERIFY: writes one check into the `checks` jsonb ({ linkedin|directory|callback: { status, evidence?,
 * note?, at } }). The verified[]/pending[] arrays in the DTO are DERIVED from that map (a check is
 * "verified" when its status is 'verified'; "pending" when its status is 'pending'; absent checks are
 * pending by default), so the row pills always reflect the stored map.
 *
 * APPROVE: finds-or-creates the gov user by the claim's contact_email (via the UserProvisioner seam, a
 * tiny slice of the Phase 1 UserStore), sets that user's role to `gov_admin` (idempotent setRole), links
 * it to the claim (gov_claims.user_id) and the jurisdiction (gov_claims.jurisdiction_geoid is the link;
 * there is no separate membership table - the approved claim row IS the user<->jurisdiction binding),
 * and sets status='approved' + decided_at/by. Audited gov_claim.approved.
 *
 * REJECT: sets status='rejected' + reject_reason + decided_at/by. Audited gov_claim.rejected.
 */

import { AppError, relativeAgo } from "@civfix/shared"
import type {
  GovCheck,
  GovCheckStatus,
  GovChecks,
  GovClaimDTO,
  GovClaimListQuery,
  GovClaimListResponse,
  GovClaimStatus,
  GovMethod,
  GovVerificationCheck,
} from "@civfix/shared"
import { clampLimit } from "./pagination.js"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** The three verification checks in display order. */
export const GOV_CHECKS: readonly GovVerificationCheck[] = ["linkedin", "directory", "callback"]

/** The role granted to an approved gov claim's user. */
export const GOV_ADMIN_ROLE = "gov_admin"

// ---------------------------------------------------------------------------
// Repository seam (structural records; faked in tests)
// ---------------------------------------------------------------------------

/** The stored per-check state (status + optional evidence + note). */
export interface GovCheckRecord {
  status: GovCheckStatus
  evidence: string | null
  note: string | null
}

/** A gov_claims row projected into the service record. `checks` is the parsed jsonb map. */
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

/** Filter facet for the list (mirrors the shared GovClaimListQuery filter). */
export type GovClaimFilter = "all" | GovClaimStatus

/** Normalized list arguments the repo consumes (search + facet + page window). */
export interface ListGovClaimsArgs {
  q: string | null
  filter: GovClaimFilter
  cursor: string | null
  limit: number
}

/**
 * The minimal user-provisioning slice the gov approve flow needs (a subset of the Phase 1 UserStore).
 * Injected so the service is unit-testable with an in-memory fake. `findByEmail` + `create` are the
 * find-or-create; `setRole` is the idempotent role grant.
 */
export interface ProvisionedUser {
  id: string
  email: string | null
  role: string
  /** Whether the account's owner has proven control of `email` (e.g. via Email-OTP / verified OAuth). */
  emailVerified: boolean
}

export interface UserProvisioner {
  findByEmail(email: string): Promise<ProvisionedUser | null>
  create(email: string, displayName: string): Promise<ProvisionedUser>
  setRole(id: string, role: string): Promise<ProvisionedUser>
}

/**
 * Persistence seam for the gov-provisioning domain. The Drizzle impl runs raw SQL; the offline tests
 * pass an in-memory impl. Action methods return a small result so the service can decide the 404 / audit.
 */
export interface GovClaimsRepository {
  /** Page the PENDING claims applying the search + status facet, newest-first keyset paged. */
  listPending(
    args: ListGovClaimsArgs,
  ): Promise<{ records: GovClaimRecord[]; nextCursor: string | null }>
  /** Load one claim by id (any status), or null when it does not exist. */
  getClaim(id: string): Promise<GovClaimRecord | null>
  /**
   * Write one verification check into the claim's `checks` jsonb. Returns the updated record, or null
   * when the claim does not exist.
   */
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
   * Approve the claim: link the provisioned user (gov_claims.user_id), set status='approved' +
   * decided_at/by. The user provisioning + role grant happen in the SERVICE (via UserProvisioner) before
   * this call so the repo only persists the claim transition + the user link. Returns the updated
   * record, or null when the claim does not exist / is not pending.
   */
  approve(
    id: string,
    input: { userId: string; actorId: string | null; note: string | null },
  ): Promise<GovClaimRecord | null>
  /**
   * Reject the claim: set status='rejected' + reject_reason + decided_at/by. Returns the updated record,
   * or null when the claim does not exist / is not pending.
   */
  reject(
    id: string,
    input: { reason: string; actorId: string | null },
  ): Promise<GovClaimRecord | null>
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB, no IO)
// ---------------------------------------------------------------------------

/** Project the stored checks map into the full strict GovChecks DTO (absent checks default pending). */
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

/** The checks whose status is 'verified', in display order. */
export function verifiedChecks(
  checks: Partial<Record<GovVerificationCheck, GovCheckRecord>>,
): GovVerificationCheck[] {
  return GOV_CHECKS.filter((c) => checks[c]?.status === "verified")
}

/** The checks still pending (status 'pending' OR absent), in display order. */
export function pendingChecks(
  checks: Partial<Record<GovVerificationCheck, GovCheckRecord>>,
): GovVerificationCheck[] {
  return GOV_CHECKS.filter((c) => (checks[c]?.status ?? "pending") === "pending")
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface GovClaimsServiceDeps {
  repo: GovClaimsRepository
  users: UserProvisioner
  /** Injectable clock (defaults to Date.now) so the relative-age labels are deterministic. */
  now?: () => Date
}

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
      actorId: string | null
    },
  ): Promise<void>
  approve(id: string, input: { actorId: string | null; note: string | null }): Promise<void>
  reject(id: string, input: { reason: string; actorId: string | null }): Promise<void>
}

export function makeGovClaimsService(deps: GovClaimsServiceDeps): GovClaimsService {
  const now = deps.now ?? (() => new Date())

  /** Project a claim record into the wire DTO (relative age + derived verified/pending arrays). */
  function toDTO(record: GovClaimRecord, ref: Date): GovClaimDTO {
    return {
      id: record.id,
      name: record.name,
      // The strict DTO requires non-null title/org/contactEmail (the design always renders them); a
      // claim with a missing field degrades to an empty string so the contract still validates.
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

  return {
    async list(query: GovClaimListQuery): Promise<GovClaimListResponse> {
      const ref = now()
      const args: ListGovClaimsArgs = {
        q: query.q && query.q.trim() !== "" ? query.q.trim() : null,
        filter: (query.filter ?? "all") as GovClaimFilter,
        cursor: query.cursor ?? null,
        limit: clampLimit(query.limit),
      }
      const { records, nextCursor } = await deps.repo.listPending(args)
      return { items: records.map((r) => toDTO(r, ref)), nextCursor }
    },

    async getClaim(id: string): Promise<GovClaimDTO> {
      const ref = now()
      const record = await deps.repo.getClaim(id)
      if (!record) throw AppError.notFound("Gov claim not found")
      return toDTO(record, ref)
    },

    async verify(
      id: string,
      input: {
        check: GovVerificationCheck
        status: GovCheckStatus
        evidence: string | null
        note: string | null
        actorId: string | null
      },
    ): Promise<void> {
      const updated = await deps.repo.setCheck(id, input)
      if (!updated) throw AppError.notFound("Gov claim not found")
    },

    async approve(
      id: string,
      input: { actorId: string | null; note: string | null },
    ): Promise<void> {
      const claim = await deps.repo.getClaim(id)
      if (!claim) throw AppError.notFound("Gov claim not found")
      if (claim.status !== "pending") {
        throw AppError.conflict("Gov claim is not pending")
      }
      const email = claim.contactEmail?.trim()
      if (!email) {
        throw AppError.validation(
          { contactEmail: "required" },
          "Cannot approve a gov claim without a contact email",
        )
      }

      // M2: do the privilege grant ONLY AFTER the claim transition durably commits, so a concurrent
      // decision (approve returns null -> 409) or a failed transition never leaves a gov_admin elevation
      // with no approved claim to justify it (decisions 3.2: the approved claim row IS the binding).
      // Find-or-create the user first (no privilege implication - this neither elevates nor is the grant),
      // then persist the claim transition + user<->jurisdiction link + audit (repo.approve, one tx).
      let user = await deps.users.findByEmail(email)
      if (user) {
        // SECURITY (privilege escalation): a claim's contact_email is unverified free text typed into the
        // form. Granting gov_admin to a PRE-EXISTING account whose email is not verified would let an
        // operator (or a duped/compromised operator) elevate an ARBITRARY victim account by entering its
        // address. Only elevate a pre-existing account whose owner has demonstrably controlled the address.
        if (!user.emailVerified) {
          throw AppError.validation(
            { contactEmail: "unverified" },
            "Cannot elevate an existing account whose email is not verified",
          )
        }
      } else {
        // No account yet: create a placeholder with an UNverified email. It has no sessions and only
        // becomes usable when the real owner signs in via Email-OTP, which proves control of the address.
        user = await deps.users.create(email, claim.name)
      }

      const updated = await deps.repo.approve(id, {
        userId: user.id,
        actorId: input.actorId,
        note: input.note,
      })
      if (!updated) {
        // The claim moved out of pending between the check and the write (a concurrent decision). The user
        // has NOT been elevated, so there is nothing to compensate.
        throw AppError.conflict("Gov claim is not pending")
      }

      // The approved claim is committed; now grant gov_admin (idempotent). A failure here surfaces (500)
      // with the claim already approved + the link recorded, which is the recoverable direction (an
      // operator can re-approve or the role can be re-granted) - the unrecoverable orphan-elevation the
      // review flagged (granted role, no claim) can no longer happen.
      if (user.role !== GOV_ADMIN_ROLE) {
        await deps.users.setRole(user.id, GOV_ADMIN_ROLE)
      }
    },

    async reject(id: string, input: { reason: string; actorId: string | null }): Promise<void> {
      const updated = await deps.repo.reject(id, input)
      if (!updated) {
        // Distinguish missing from already-decided so the operator gets an accurate error.
        const claim = await deps.repo.getClaim(id)
        if (!claim) throw AppError.notFound("Gov claim not found")
        throw AppError.conflict("Gov claim is not pending")
      }
    },
  }
}
