/**
 * In-memory GovClaimsRepository (Phase 2): the offline binding of the gov-provisioning persistence seam.
 *
 * Mirrors the Drizzle impl's OBSERVABLE contract so the gov-claims service can be unit-tested with NO
 * database (no Docker):
 *   - listPending pages only PENDING claims, applying the search (name/org) + the status facet,
 *     newest-first by createdAt with an id tiebreak;
 *   - getClaim returns the seeded record at any status;
 *   - setCheck writes one check into the record's checks map (any status);
 *   - approve links the user + sets status='approved' (only when pending);
 *   - reject sets status='rejected' + reject_reason (only when pending).
 * Seed/inspect helpers (seedClaim, the public claims map) let tests arrange + assert state directly.
 *
 * Pairs with InMemoryUserProvisioner (below): a tiny find-or-create + setRole fake matching the
 * UserProvisioner seam, so an approve test can assert the user was created with role gov_admin.
 */

import { randomUUID } from "node:crypto"
import { clampLimit, decodeCursor, encodeCursor } from "./pagination.js"
import {
  type GovCheckRecord,
  type GovClaimRecord,
  type GovClaimsRepository,
  type ListGovClaimsArgs,
  type ProvisionedUser,
  type UserProvisioner,
} from "./gov-claims-service.js"
import type { GovCheckStatus, GovVerificationCheck } from "@civfix/shared"

/** An in-memory GovClaimsRepository faithful to the Drizzle impl's observable behavior. */
export class InMemoryGovClaimsRepository implements GovClaimsRepository {
  /** Seeded claims keyed by id (insertion order preserved for stable paging). */
  readonly claims = new Map<string, GovClaimRecord>()

  /** Deterministic clock; each seeded claim advances by one millisecond for stable ordering. */
  now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))
  private tick = 0

  private nextDate(): Date {
    this.tick += 1
    return new Date(this.now.getTime() + this.tick)
  }

  /** Seed a claim. Defaults fill the fields so a test only sets what it asserts on. */
  seedClaim(input: Partial<GovClaimRecord> & { id?: string; name?: string }): GovClaimRecord {
    const id = input.id ?? randomUUID()
    const record: GovClaimRecord = {
      id,
      userId: input.userId ?? null,
      name: input.name ?? "Jane Roe",
      title: input.title ?? null,
      org: input.org ?? null,
      jurisdictionGeoid: input.jurisdictionGeoid ?? null,
      method: input.method ?? "email",
      contactEmail: input.contactEmail ?? null,
      status: input.status ?? "pending",
      checks: input.checks ?? {},
      rejectReason: input.rejectReason ?? null,
      createdAt: input.createdAt ?? this.nextDate(),
    }
    this.claims.set(id, record)
    return record
  }

  async listPending(
    args: ListGovClaimsArgs,
  ): Promise<{ records: GovClaimRecord[]; nextCursor: string | null }> {
    let rows = [...this.claims.values()].filter((r) => r.status === "pending")

    // The status facet narrows further (mostly "all"/"pending" for the pending queue, but a test may
    // request "approved"/"rejected" which yields nothing here since listPending is pending-only).
    if (args.filter !== "all") {
      rows = rows.filter((r) => r.status === args.filter)
    }

    // Search: name OR org, case-insensitive.
    if (args.q !== null) {
      const needle = args.q.toLowerCase()
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(needle) || (r.org ?? "").toLowerCase().includes(needle),
      )
    }

    // Newest-first by createdAt; id is the stable tiebreak (desc) so the keyset cursor pages
    // deterministically.
    rows.sort((a, b) => {
      const primary = b.createdAt.getTime() - a.createdAt.getTime()
      if (primary !== 0) return primary
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    })

    const limit = clampLimit(args.limit)
    const anchor = decodeCursor(args.cursor)
    let start = 0
    if (anchor) {
      const idx = rows.findIndex((r) => r.id === anchor.id)
      start = idx >= 0 ? idx + 1 : rows.length
    }
    const slice = rows.slice(start, start + limit + 1)
    if (slice.length <= limit) {
      return { records: slice, nextCursor: null }
    }
    const records = slice.slice(0, limit)
    const last = records[records.length - 1]
    const nextCursor = last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null
    return { records, nextCursor }
  }

  async getClaim(id: string): Promise<GovClaimRecord | null> {
    return this.claims.get(id) ?? null
  }

  async setCheck(
    id: string,
    input: {
      check: GovVerificationCheck
      status: GovCheckStatus
      evidence: string | null
      note: string | null
      actorId: string | null
    },
  ): Promise<GovClaimRecord | null> {
    const claim = this.claims.get(id)
    if (!claim) return null
    const check: GovCheckRecord = {
      status: input.status,
      evidence: input.evidence,
      note: input.note,
    }
    claim.checks = { ...claim.checks, [input.check]: check }
    return claim
  }

  async approve(
    id: string,
    input: { userId: string; actorId: string | null; note: string | null },
  ): Promise<GovClaimRecord | null> {
    const claim = this.claims.get(id)
    if (!claim || claim.status !== "pending") return null
    claim.status = "approved"
    claim.userId = input.userId
    return claim
  }

  async reject(
    id: string,
    input: { reason: string; actorId: string | null },
  ): Promise<GovClaimRecord | null> {
    const claim = this.claims.get(id)
    if (!claim || claim.status !== "pending") return null
    claim.status = "rejected"
    claim.rejectReason = input.reason
    return claim
  }
}

/**
 * In-memory UserProvisioner: a find-or-create-by-email + idempotent setRole fake matching the seam the
 * gov approve flow depends on. Mirrors the observable behavior of the Phase 1 UserStore slice (email
 * matched case-insensitively, like the CITEXT users.email column).
 */
export class InMemoryUserProvisioner implements UserProvisioner {
  readonly users = new Map<string, ProvisionedUser>()

  /** Seed an existing user (e.g. to test the find branch of approve). */
  seedUser(input: { id?: string; email: string; role?: string }): ProvisionedUser {
    const user: ProvisionedUser = {
      id: input.id ?? randomUUID(),
      email: input.email.toLowerCase(),
      role: input.role ?? "citizen",
    }
    this.users.set(user.id, user)
    return user
  }

  async findByEmail(email: string): Promise<ProvisionedUser | null> {
    const normalized = email.toLowerCase()
    for (const user of this.users.values()) {
      if (user.email !== null && user.email.toLowerCase() === normalized) return { ...user }
    }
    return null
  }

  async create(email: string, _displayName: string): Promise<ProvisionedUser> {
    const user: ProvisionedUser = { id: randomUUID(), email: email.toLowerCase(), role: "citizen" }
    this.users.set(user.id, user)
    return { ...user }
  }

  async setRole(id: string, role: string): Promise<ProvisionedUser> {
    const user = this.users.get(id)
    if (!user) throw new Error("InMemoryUserProvisioner.setRole: user not found")
    user.role = role
    return { ...user }
  }
}
