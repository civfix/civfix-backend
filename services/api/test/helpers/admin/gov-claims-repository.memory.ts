// Mirrors the Drizzle repository's observable behavior.

import { randomUUID } from "node:crypto"
import { pageInMemoryById } from "../../../src/services/admin/pagination.js"
import {
  type ProvisionedUser,
  type UserProvisioner,
} from "../../../src/services/admin/gov-claims-service.js"
import type {
  GovCheckRecord,
  GovClaimRecord,
  GovClaimsRepository,
  ListGovClaimsArgs,
} from "../../../src/services/admin/gov-claims-repository.js"
import type { GovCheckStatus, GovVerificationCheck, Role } from "@civfix/shared"

export class InMemoryGovClaimsRepository implements GovClaimsRepository {
  /** Insertion order is preserved for stable paging. */
  readonly claims = new Map<string, GovClaimRecord>()

  now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))
  private tick = 0

  private nextDate(): Date {
    this.tick += 1
    return new Date(this.now.getTime() + this.tick)
  }

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

  async list(
    args: ListGovClaimsArgs,
  ): Promise<{ records: GovClaimRecord[]; nextCursor: string | null }> {
    let rows = [...this.claims.values()]

    if (args.filter !== "all") {
      rows = rows.filter((r) => r.status === args.filter)
    }

    if (args.q !== null) {
      const needle = args.q.toLowerCase()
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(needle) || (r.org ?? "").toLowerCase().includes(needle),
      )
    }

    // The id tiebreak runs in the same direction as the Drizzle (created_at, id) keyset, so a page
    // boundary lands identically.
    const dir = args.sort === "oldest" ? 1 : -1
    rows.sort((a, b) => {
      const primary = (a.createdAt.getTime() - b.createdAt.getTime()) * dir
      if (primary !== 0) return primary
      return (a.id > b.id ? 1 : a.id < b.id ? -1 : 0) * dir
    })

    return pageInMemoryById(rows, args.cursor, args.limit, (r) => ({
      at: r.createdAt,
      id: r.id,
    }))
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
    // Mirrors the Drizzle WHERE status='pending' guard: a decided claim's checks are immutable.
    if (!claim || claim.status !== "pending") return null
    const check: GovCheckRecord = {
      status: input.status,
      evidence: input.evidence,
      note: input.note,
    }
    claim.checks = { ...claim.checks, [input.check]: check }
    return { ...claim }
  }

  async approve(
    id: string,
    input: { userId: string; actorId: string | null; note: string | null },
  ): Promise<GovClaimRecord | null> {
    const claim = this.claims.get(id)
    if (!claim || claim.status !== "pending") return null
    claim.status = "approved"
    claim.userId = input.userId
    return { ...claim }
  }

  async reject(
    id: string,
    input: { reason: string; actorId: string | null },
  ): Promise<GovClaimRecord | null> {
    const claim = this.claims.get(id)
    if (!claim || claim.status !== "pending") return null
    claim.status = "rejected"
    claim.rejectReason = input.reason
    return { ...claim }
  }
}

/** Email is matched case-insensitively, like the CITEXT users.email column. */
export class InMemoryUserProvisioner implements UserProvisioner {
  readonly users = new Map<string, ProvisionedUser>()

  /**
   * Defaults to a verified email so the common "approve an existing account" test still elevates; pass
   * emailVerified:false to exercise the unverified-rejection guard.
   */
  seedUser(input: {
    id?: string
    email: string
    role?: string
    emailVerified?: boolean
  }): ProvisionedUser {
    const user: ProvisionedUser = {
      id: input.id ?? randomUUID(),
      email: input.email.toLowerCase(),
      role: input.role ?? "citizen",
      emailVerified: input.emailVerified ?? true,
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
    const user: ProvisionedUser = {
      id: randomUUID(),
      email: email.toLowerCase(),
      role: "citizen",
      emailVerified: false,
    }
    this.users.set(user.id, user)
    return { ...user }
  }

  async setRole(id: string, role: Role): Promise<ProvisionedUser> {
    const user = this.users.get(id)
    if (!user) throw new Error("InMemoryUserProvisioner.setRole: user not found")
    user.role = role
    return { ...user }
  }
}
