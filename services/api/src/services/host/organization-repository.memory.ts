import { randomUUID } from "node:crypto"
import type { OrganizationMemberRole, OrgVerificationKind, SocialLinks } from "@civfix/shared"
import { normalizeEin } from "../payments/eligibility-sources.js"
import type { SetEinInput } from "../payments/eligibility-repository.drizzle.js"
import type {
  AddOrganizationMemberOutcome,
  AdminOrgListQuery,
  AdminOrgVerificationRecord,
  ApplyOrgVerificationArgs,
  CreateOrganizationArgs,
  DecideOrgVerificationArgs,
  DecideOrgVerificationOutcome,
  OrganizationMemberRecord,
  OrganizationOwnerRecord,
  OrganizationRecord,
  OrganizationRepository,
  OrgMemberIdentifier,
  OrgVerificationRecord,
  RemoveOrganizationMemberOutcome,
  SetOrganizationMemberRoleOutcome,
  UpdateOrganizationPatch,
} from "./organization-repository.types.js"

interface StoredOrganization {
  id: string
  slug: string
  name: string
  description: string | null
  websiteUrl: string | null
  logoMediaId: string | null
  socialLinks: SocialLinks | null
  verifiedStatus: OrganizationRecord["verifiedStatus"]
  verifiedKind: OrgVerificationKind | null
  verifiedAt: Date | null
  createdBy: string | null
  createdAt: Date
  deletedAt: Date | null
}

interface StoredMember {
  organizationId: string
  userId: string
  role: OrganizationMemberRole
  joinedAt: Date
}

interface StoredVerification {
  id: string
  organizationId: string
  status: OrganizationRecord["verifiedStatus"]
  kind: OrgVerificationKind
  einNumber: string | null
  einScrubbedAt: Date | null
  documentMediaIds: string[]
  note: string | null
  rejectionReason: string | null
  submittedBy: string | null
  submittedAt: Date
  reviewedBy: string | null
  reviewedAt: Date | null
}

interface StoredPerson {
  id: string
  displayName: string
  handle: string | null
  email: string | null
  bio: string | null
  createdAt: Date
}

export class InMemoryOrganizationRepository implements OrganizationRepository {
  readonly organizations = new Map<string, StoredOrganization>()
  readonly members: StoredMember[] = []
  readonly verifications: StoredVerification[] = []
  eligibilityEinSink: ((input: SetEinInput) => void) | null = null
  readonly users = new Map<string, StoredPerson>()
  readonly eventCounts = new Map<string, number>()
  readonly audits: {
    actorId: string
    action: string
    target: string
    meta?: Record<string, unknown>
  }[] = []

  seedUser(over: Partial<StoredPerson> = {}): StoredPerson {
    const person: StoredPerson = {
      id: over.id ?? randomUUID(),
      displayName: over.displayName ?? "Member",
      handle: over.handle ?? null,
      email: over.email ?? null,
      bio: over.bio ?? null,
      createdAt: over.createdAt ?? new Date("2025-01-01T00:00:00.000Z"),
    }
    this.users.set(person.id, person)
    return person
  }

  private personOf(userId: string): StoredPerson {
    return this.users.get(userId) ?? this.seedUser({ id: userId })
  }

  private toRecord(org: StoredOrganization, viewerId: string | null): OrganizationRecord {
    return {
      id: org.id,
      slug: org.slug,
      name: org.name,
      description: org.description,
      websiteUrl: org.websiteUrl,
      logoMediaId: org.logoMediaId,
      logoKey: org.logoMediaId === null ? null : `media/${org.logoMediaId}`,
      socialLinks: org.socialLinks,
      verifiedStatus: org.verifiedStatus,
      verifiedKind: org.verifiedKind,
      verifiedAt: org.verifiedAt,
      createdBy: org.createdBy,
      createdAt: org.createdAt,
      deletedAt: org.deletedAt,
      memberCount: this.members.filter((m) => m.organizationId === org.id).length,
      eventCount: this.eventCounts.get(org.id) ?? 0,
      myRole:
        viewerId === null
          ? null
          : (this.members.find((m) => m.organizationId === org.id && m.userId === viewerId)?.role ??
            null),
    }
  }

  createOrganizationTx(args: CreateOrganizationArgs): Promise<OrganizationRecord | "slug_taken"> {
    const taken = [...this.organizations.values()].some(
      (o) => o.slug === args.slug && o.deletedAt === null,
    )
    if (taken) return Promise.resolve("slug_taken")
    const org: StoredOrganization = {
      id: args.organizationId,
      slug: args.slug,
      name: args.name,
      description: args.description,
      websiteUrl: args.websiteUrl,
      logoMediaId: args.logoMediaId,
      socialLinks: args.socialLinks,
      verifiedStatus: "unverified",
      verifiedKind: null,
      verifiedAt: null,
      createdBy: args.createdBy,
      createdAt: args.now,
      deletedAt: null,
    }
    this.organizations.set(org.id, org)
    this.members.push({
      organizationId: org.id,
      userId: args.createdBy,
      role: "owner",
      joinedAt: args.now,
    })
    this.personOf(args.createdBy)
    return Promise.resolve(this.toRecord(org, args.createdBy))
  }

  findOrganizationById(id: string, viewerId: string | null): Promise<OrganizationRecord | null> {
    const org = this.organizations.get(id)
    return Promise.resolve(
      org === undefined || org.deletedAt !== null ? null : this.toRecord(org, viewerId),
    )
  }

  findOrganizationBySlug(slug: string, viewerId: string | null): Promise<OrganizationRecord | null> {
    const org = [...this.organizations.values()].find(
      (o) => o.slug === slug && o.deletedAt === null,
    )
    return Promise.resolve(org === undefined ? null : this.toRecord(org, viewerId))
  }

  listMyOrganizations(userId: string, limit: number): Promise<OrganizationRecord[]> {
    const ids = new Set(this.members.filter((m) => m.userId === userId).map((m) => m.organizationId))
    const records = [...this.organizations.values()]
      .filter((o) => ids.has(o.id) && o.deletedAt === null)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((o) => this.toRecord(o, userId))
    return Promise.resolve(records)
  }

  updateOrganizationTx(
    id: string,
    patch: UpdateOrganizationPatch,
    _now: Date,
  ): Promise<boolean> {
    const org = this.organizations.get(id)
    if (org === undefined || org.deletedAt !== null) return Promise.resolve(false)
    if (patch.name !== undefined) org.name = patch.name
    if (patch.description !== undefined) org.description = patch.description
    if (patch.websiteUrl !== undefined) org.websiteUrl = patch.websiteUrl
    if (patch.logoMediaId !== undefined) org.logoMediaId = patch.logoMediaId
    if (patch.socialLinks !== undefined) org.socialLinks = patch.socialLinks
    return Promise.resolve(true)
  }

  roleOf(organizationId: string, userId: string): Promise<OrganizationMemberRole | null> {
    const org = this.organizations.get(organizationId)
    if (org === undefined || org.deletedAt !== null) return Promise.resolve(null)
    const member = this.members.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    )
    return Promise.resolve(member?.role ?? null)
  }

  listMembers(args: {
    organizationId: string
    cursor: string | null
    limit: number
  }): Promise<{ items: OrganizationMemberRecord[]; nextCursor: string | null }> {
    const all = this.members
      .filter((m) => m.organizationId === args.organizationId)
      .sort(
        (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || a.userId.localeCompare(b.userId),
      )
    const start =
      args.cursor === null
        ? 0
        : all.findIndex((m) => `${m.joinedAt.toISOString()}|${m.userId}` === args.cursor) + 1
    const page = all.slice(start, start + args.limit)
    const next = all.length > start + args.limit ? page[page.length - 1] : undefined
    return Promise.resolve({
      items: page.map((m) => {
        const person = this.personOf(m.userId)
        return {
          person: {
            id: person.id,
            displayName: person.displayName,
            handle: person.handle,
            bio: person.bio,
          },
          role: m.role,
          joinedAt: m.joinedAt,
        }
      }),
      nextCursor: next === undefined ? null : `${next.joinedAt.toISOString()}|${next.userId}`,
    })
  }

  findMember(organizationId: string, userId: string): Promise<OrganizationMemberRecord | null> {
    const member = this.members.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    )
    if (member === undefined) return Promise.resolve(null)
    const person = this.personOf(member.userId)
    return Promise.resolve({
      person: { id: person.id, displayName: person.displayName, handle: person.handle, bio: person.bio },
      role: member.role,
      joinedAt: member.joinedAt,
    })
  }

  findOwner(organizationId: string): Promise<OrganizationOwnerRecord | null> {
    const owner = this.members.find(
      (m) => m.organizationId === organizationId && m.role === "owner",
    )
    if (owner === undefined) return Promise.resolve(null)
    const person = this.personOf(owner.userId)
    return Promise.resolve({
      userId: person.id,
      displayName: person.displayName,
      email: person.email,
    })
  }

  resolveUserByIdentifier(identifier: OrgMemberIdentifier): Promise<string | null> {
    const match = [...this.users.values()].find((u) =>
      identifier.identifierKind === "handle"
        ? u.handle === identifier.identifier
        : u.email === identifier.identifier,
    )
    return Promise.resolve(match?.id ?? null)
  }

  addMemberTx(args: {
    organizationId: string
    userId: string
    role: "admin" | "member"
    actorId: string
    now: Date
  }): Promise<AddOrganizationMemberOutcome> {
    const existing = this.members.find(
      (m) => m.organizationId === args.organizationId && m.userId === args.userId,
    )
    if (existing !== undefined) return Promise.resolve("already_member")
    this.members.push({
      organizationId: args.organizationId,
      userId: args.userId,
      role: args.role,
      joinedAt: args.now,
    })
    this.audits.push({
      actorId: args.actorId,
      action: "org.member_role_changed",
      target: `organization:${args.organizationId}`,
    })
    return Promise.resolve("added")
  }

  setMemberRoleTx(args: {
    organizationId: string
    userId: string
    role: "admin" | "member"
    actorId: string
  }): Promise<SetOrganizationMemberRoleOutcome> {
    const member = this.members.find(
      (m) => m.organizationId === args.organizationId && m.userId === args.userId,
    )
    if (member === undefined) return Promise.resolve("not_member")
    if (member.role === "owner") return Promise.resolve("owner")
    if (member.role !== args.role) {
      member.role = args.role
      this.audits.push({
        actorId: args.actorId,
        action: "org.member_role_changed",
        target: `organization:${args.organizationId}`,
      })
    }
    return Promise.resolve("updated")
  }

  removeMemberTx(args: {
    organizationId: string
    userId: string
    actorId: string
  }): Promise<RemoveOrganizationMemberOutcome> {
    const index = this.members.findIndex(
      (m) => m.organizationId === args.organizationId && m.userId === args.userId,
    )
    if (index < 0) return Promise.resolve("not_member")
    const member = this.members[index]
    if (member === undefined) return Promise.resolve("not_member")
    if (member.role === "owner") return Promise.resolve("owner")
    this.members.splice(index, 1)
    this.audits.push({
      actorId: args.actorId,
      action: "org.member_removed",
      target: `organization:${args.organizationId}`,
    })
    return Promise.resolve("removed")
  }

  applyVerificationTx(args: ApplyOrgVerificationArgs): Promise<OrgVerificationRecord> {
    const open = this.verifications.find(
      (v) => v.organizationId === args.organizationId && v.status === "pending",
    )
    if (open !== undefined) {
      open.kind = args.kind
      open.einNumber = args.einNumber
      open.einScrubbedAt = null
      const submitted = [...new Set(args.documentMediaIds)]
      open.documentMediaIds = submitted.length === 0 ? open.documentMediaIds : submitted
      open.note = args.note
      open.submittedBy = args.submittedBy
      open.submittedAt = args.now
      this.audits.push({
        actorId: args.submittedBy,
        action: "org.verification_submitted",
        target: `organization:${args.organizationId}`,
      })
      return Promise.resolve(this.toVerificationRecord(open))
    }
    const row: StoredVerification = {
      id: args.verificationId,
      organizationId: args.organizationId,
      status: "pending",
      kind: args.kind,
      einNumber: args.einNumber,
      einScrubbedAt: null,
      documentMediaIds: [...new Set(args.documentMediaIds)],
      note: args.note,
      rejectionReason: null,
      submittedBy: args.submittedBy,
      submittedAt: args.now,
      reviewedBy: null,
      reviewedAt: null,
    }
    this.verifications.push(row)
    const org = this.organizations.get(args.organizationId)
    if (org !== undefined && org.verifiedStatus !== "verified") org.verifiedStatus = "pending"
    this.audits.push({
      actorId: args.submittedBy,
      action: "org.verification_submitted",
      target: `organization:${args.organizationId}`,
    })
    return Promise.resolve(this.toVerificationRecord(row))
  }

  private toVerificationRecord(row: StoredVerification): OrgVerificationRecord {
    return {
      status: row.status,
      kind: row.kind,
      submittedAt: row.submittedAt,
      reviewedAt: row.reviewedAt,
      rejectionReason: row.rejectionReason,
    }
  }

  private latestFor(organizationId: string): StoredVerification | undefined {
    return this.verifications
      .filter((v) => v.organizationId === organizationId)
      .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime())[0]
  }

  getVerification(organizationId: string): Promise<OrgVerificationRecord | null> {
    const row = this.latestFor(organizationId)
    return Promise.resolve(row === undefined ? null : this.toVerificationRecord(row))
  }

  private toAdminRecord(row: StoredVerification): AdminOrgVerificationRecord {
    const org = this.organizations.get(row.organizationId)
    const submitter = row.submittedBy === null ? null : this.personOf(row.submittedBy)
    const reviewer = row.reviewedBy === null ? null : this.personOf(row.reviewedBy)
    return {
      id: row.id,
      organizationId: row.organizationId,
      slug: org?.slug ?? "",
      name: org?.name ?? "",
      status: row.status,
      kind: row.kind,
      einLast4: row.einNumber === null ? null : row.einNumber.slice(-4),
      documentMediaIds: [...row.documentMediaIds],
      note: row.note,
      submittedAt: row.submittedAt,
      reviewedAt: row.reviewedAt,
      rejectionReason: row.rejectionReason,
      submittedBy:
        submitter === null
          ? null
          : {
              id: submitter.id,
              name: submitter.displayName,
              handle: submitter.handle ?? "",
              joined: submitter.createdAt,
            },
      reviewedBy:
        reviewer === null
          ? null
          : {
              id: reviewer.id,
              name: reviewer.displayName,
              handle: reviewer.handle ?? "",
              joined: reviewer.createdAt,
            },
    }
  }

  adminListVerifications(query: AdminOrgListQuery): Promise<{
    items: AdminOrgVerificationRecord[]
    nextCursor: string | null
    pendingCount: number
  }> {
    const rows = this.verifications
      .filter((v) => query.status === undefined || v.status === query.status)
      .filter((v) => query.kind === undefined || v.kind === query.kind)
      .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime())
    const start =
      query.cursor === null
        ? 0
        : rows.findIndex((v) => `${v.submittedAt.toISOString()}|${v.id}` === query.cursor) + 1
    const page = rows.slice(start, start + query.limit)
    const next = rows.length > start + query.limit ? page[page.length - 1] : undefined
    return Promise.resolve({
      items: page.map((row) => this.toAdminRecord(row)),
      nextCursor: next === undefined ? null : `${next.submittedAt.toISOString()}|${next.id}`,
      pendingCount: this.verifications.filter((v) => v.status === "pending").length,
    })
  }

  adminGetVerification(organizationId: string): Promise<AdminOrgVerificationRecord | null> {
    const row = this.latestFor(organizationId)
    return Promise.resolve(row === undefined ? null : this.toAdminRecord(row))
  }

  decideVerificationTx(args: DecideOrgVerificationArgs): Promise<DecideOrgVerificationOutcome> {
    const org = this.organizations.get(args.organizationId)
    if (org === undefined) return Promise.resolve("not_found")
    const open = this.verifications.find(
      (v) => v.organizationId === args.organizationId && v.status === "pending",
    )
    if (open === undefined) return Promise.resolve("no_application")
    const grantedKind = args.decision === "verified" ? (args.kind ?? open.kind) : open.kind
    open.status = args.decision
    open.kind = grantedKind
    open.rejectionReason = args.decision === "rejected" ? args.reason : null
    open.reviewedBy = args.reviewedBy
    open.reviewedAt = args.now
    org.verifiedStatus = args.decision
    org.verifiedKind = args.decision === "verified" ? grantedKind : null
    org.verifiedAt = args.decision === "verified" ? args.now : null
    const verifiedEin =
      args.decision === "verified" && grantedKind === "nonprofit" && open.einNumber !== null
        ? normalizeEin(open.einNumber)
        : null
    if (verifiedEin !== null && this.eligibilityEinSink !== null) {
      this.eligibilityEinSink({
        organizationId: args.organizationId,
        ein: verifiedEin,
        source: "org_verification",
        actorUserId: args.reviewedBy,
        now: args.now,
      })
    }
    this.audits.push({
      actorId: args.reviewedBy,
      action:
        args.decision === "verified" ? "org.verification_verified" : "org.verification_rejected",
      target: `organization:${args.organizationId}`,
      meta: { kind: grantedKind, reason: args.reason },
    })
    return Promise.resolve("decided")
  }

  verifiedEinOf(organizationId: string): Promise<string | null> {
    const verified = this.verifications
      .filter((v) => v.organizationId === organizationId && v.status === "verified")
      .sort((a, b) => (b.reviewedAt?.getTime() ?? 0) - (a.reviewedAt?.getTime() ?? 0))
    return Promise.resolve(verified[0]?.einNumber ?? null)
  }

  scrubDecidedEins(before: Date, limit: number): Promise<number> {
    let scrubbed = 0
    for (const row of this.verifications) {
      if (scrubbed >= limit) break
      if (
        row.einNumber !== null &&
        row.einScrubbedAt === null &&
        row.reviewedAt !== null &&
        row.reviewedAt.getTime() < before.getTime()
      ) {
        row.einNumber = null
        row.einScrubbedAt = before
        scrubbed += 1
      }
    }
    return Promise.resolve(scrubbed)
  }
}
