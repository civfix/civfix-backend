import { randomUUID } from "node:crypto"
import type {
  OrganizationInviteRole,
  OrganizationInviteStatus,
  OrganizationMemberRole,
  OrgPaymentsState,
  OrgVerificationKind,
  SocialLinks,
} from "@civfix/shared"
import { normalizeEin } from "../payments/eligibility-sources.js"
import type { SetEinInput } from "../payments/eligibility-repository.drizzle.js"
import type {
  AcceptOrganizationInviteOutcome,
  AddOrganizationMemberOutcome,
  AdminActorView,
  AdminAddMemberArgs,
  AdminAddMemberOutcome,
  AdminOrganizationCounts,
  AdminOrganizationListQuery,
  AdminOrganizationRecord,
  AdminOrgListQuery,
  AdminOrgMemberRecord,
  AdminOrgVerificationRecord,
  AdminSetMemberRoleArgs,
  AdminSetMemberRoleOutcome,
  ApplyOrgVerificationArgs,
  CreateOrganizationArgs,
  CreateOrganizationInviteArgs,
  CreateOrganizationInviteOutcome,
  DecideOrgVerificationArgs,
  DecideOrgVerificationOutcome,
  OrganizationInviteRecord,
  OrganizationMemberRecord,
  OrganizationOwnerRecord,
  OrganizationRecord,
  OrganizationRepository,
  OrgMemberIdentifier,
  OrgVerificationRecord,
  RemoveOrganizationMemberOutcome,
  RevokeOrganizationInviteOutcome,
  SetOrganizationMemberRoleOutcome,
  SetOrganizationSuspendedArgs,
  SetOrganizationSuspendedOutcome,
  UpdateOrganizationAudit,
  UpdateOrganizationOutcome,
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
  updatedAt: Date
  deletedAt: Date | null
  suspendedAt: Date | null
  suspendedReason: string | null
}

interface StoredInvite {
  id: string
  organizationId: string
  email: string | null
  userId: string | null
  role: OrganizationInviteRole
  status: OrganizationInviteStatus
  tokenHash: string
  invitedBy: string | null
  createdAt: Date
  expiresAt: Date
  acceptedAt: Date | null
  revokedAt: Date | null
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
  deletedAt: Date | null
}

export class InMemoryOrganizationRepository implements OrganizationRepository {
  readonly organizations = new Map<string, StoredOrganization>()
  readonly members: StoredMember[] = []
  readonly verifications: StoredVerification[] = []
  readonly invites: StoredInvite[] = []
  /** Per-org donation/payout state the admin list facets read (org_donation_settings / org_stripe_accounts). */
  readonly donationsEnabled = new Map<string, boolean>()
  readonly paymentsStates = new Map<string, OrgPaymentsState>()
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
      deletedAt: over.deletedAt ?? null,
    }
    this.users.set(person.id, person)
    return person
  }

  private actorOf(userId: string): AdminActorView {
    const person = this.personOf(userId)
    return {
      id: person.id,
      name: person.displayName,
      handle: person.handle ?? "",
      joined: person.createdAt,
    }
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
      updatedAt: org.updatedAt,
      deletedAt: org.deletedAt,
      suspendedAt: org.suspendedAt,
      suspendedReason: org.suspendedReason,
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
    const ownerUserId = args.ownerUserId ?? args.createdBy
    const verifiedKind = args.verifiedKind ?? null
    const org: StoredOrganization = {
      id: args.organizationId,
      slug: args.slug,
      name: args.name,
      description: args.description,
      websiteUrl: args.websiteUrl,
      logoMediaId: args.logoMediaId,
      socialLinks: args.socialLinks,
      verifiedStatus: verifiedKind === null ? "unverified" : "verified",
      verifiedKind,
      verifiedAt: verifiedKind === null ? null : args.now,
      createdBy: args.createdBy,
      createdAt: args.now,
      updatedAt: args.now,
      deletedAt: null,
      suspendedAt: null,
      suspendedReason: null,
    }
    this.organizations.set(org.id, org)
    this.members.push({
      organizationId: org.id,
      userId: ownerUserId,
      role: "owner",
      joinedAt: args.now,
    })
    this.personOf(ownerUserId)
    if (args.operatorReason !== undefined) {
      this.audits.push({
        actorId: args.createdBy,
        action: "org.created",
        target: `organization:${org.id}`,
        meta: { reason: args.operatorReason, ownerUserId, slug: args.slug, verifiedKind },
      })
    }
    if (verifiedKind !== null) {
      this.verifications.push({
        id: randomUUID(),
        organizationId: org.id,
        status: "verified",
        kind: verifiedKind,
        einNumber: null,
        einScrubbedAt: null,
        documentMediaIds: [],
        note: "Created verified by an operator.",
        rejectionReason: null,
        submittedBy: args.createdBy,
        submittedAt: args.now,
        reviewedBy: args.createdBy,
        reviewedAt: args.now,
      })
      this.audits.push({
        actorId: args.createdBy,
        action: "org.verification_verified",
        target: `organization:${org.id}`,
        meta: { kind: verifiedKind, reason: args.operatorReason ?? null, source: "operator_create" },
      })
    }
    return Promise.resolve(this.toRecord(org, ownerUserId))
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
    now: Date,
    audit?: UpdateOrganizationAudit,
  ): Promise<UpdateOrganizationOutcome> {
    const org = this.organizations.get(id)
    if (org === undefined || org.deletedAt !== null) return Promise.resolve("not_found")
    if (patch.slug !== undefined && patch.slug !== org.slug) {
      const taken = [...this.organizations.values()].some(
        (o) => o.id !== id && o.slug === patch.slug && o.deletedAt === null,
      )
      if (taken) return Promise.resolve("slug_taken")
      org.slug = patch.slug
    }
    if (patch.name !== undefined) org.name = patch.name
    if (patch.description !== undefined) org.description = patch.description
    if (patch.websiteUrl !== undefined) org.websiteUrl = patch.websiteUrl
    if (patch.logoMediaId !== undefined) org.logoMediaId = patch.logoMediaId
    if (patch.socialLinks !== undefined) org.socialLinks = patch.socialLinks
    org.updatedAt = now
    if (audit !== undefined) {
      this.audits.push({
        actorId: audit.actorId,
        action: "org.updated",
        target: `organization:${id}`,
        meta: { reason: audit.reason, changed: audit.changed },
      })
    }
    return Promise.resolve("updated")
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
      handle: person.handle ?? "",
      email: person.email,
      joined: person.createdAt,
    })
  }

  findUser(userId: string): Promise<AdminActorView | null> {
    const person = this.users.get(userId)
    if (person === undefined || person.deletedAt !== null) return Promise.resolve(null)
    return Promise.resolve(this.actorOf(userId))
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
    reason?: string
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
      meta: {
        targetUserId: args.userId,
        role: member.role,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      },
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

  adminGetVerifications(organizationIds: string[]): Promise<Map<string, AdminOrgVerificationRecord>> {
    const out = new Map<string, AdminOrgVerificationRecord>()
    for (const id of organizationIds) {
      const row = this.latestFor(id)
      if (row !== undefined) out.set(id, this.toAdminRecord(row))
    }
    return Promise.resolve(out)
  }

  private toAdminOrganizationRecord(org: StoredOrganization): AdminOrganizationRecord {
    const owner = this.members.find((m) => m.organizationId === org.id && m.role === "owner")
    return {
      ...this.toRecord(org, null),
      owner: owner === undefined ? null : this.actorOf(owner.userId),
      donationsEnabled: this.donationsEnabled.get(org.id) ?? false,
      paymentsState: this.paymentsStates.get(org.id) ?? null,
    }
  }

  adminFindOrganization(id: string): Promise<AdminOrganizationRecord | null> {
    const org = this.organizations.get(id)
    return Promise.resolve(
      org === undefined || org.deletedAt !== null ? null : this.toAdminOrganizationRecord(org),
    )
  }

  adminListOrganizations(query: AdminOrganizationListQuery): Promise<{
    items: AdminOrganizationRecord[]
    nextCursor: string | null
    counts: AdminOrganizationCounts | null
  }> {
    const q = query.q?.trim().toLowerCase() ?? ""
    const searched = [...this.organizations.values()].filter(
      (o) =>
        o.deletedAt === null &&
        (q.length === 0 ||
          o.name.toLowerCase().includes(q) ||
          o.slug.toLowerCase().includes(q) ||
          o.id === q),
    )
    const rows = searched
      .filter((o) => query.verified === undefined || o.verifiedStatus === query.verified)
      .filter((o) => query.kind === undefined || o.verifiedKind === query.kind)
      .filter(
        (o) => query.suspended === undefined || (o.suspendedAt !== null) === query.suspended,
      )
      .filter(
        (o) =>
          query.donationsEnabled === undefined ||
          (this.donationsEnabled.get(o.id) ?? false) === query.donationsEnabled,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
    const start =
      query.cursor === null
        ? 0
        : rows.findIndex((o) => `${o.createdAt.toISOString()}|${o.id}` === query.cursor) + 1
    const page = rows.slice(start, start + query.limit)
    const next = rows.length > start + query.limit ? page[page.length - 1] : undefined
    const counts: AdminOrganizationCounts | null =
      query.cursor === null
        ? {
            all: searched.length,
            verified: searched.filter((o) => o.verifiedStatus === "verified").length,
            pending: searched.filter((o) => o.verifiedStatus === "pending").length,
            suspended: searched.filter((o) => o.suspendedAt !== null).length,
          }
        : null
    return Promise.resolve({
      items: page.map((o) => this.toAdminOrganizationRecord(o)),
      nextCursor: next === undefined ? null : `${next.createdAt.toISOString()}|${next.id}`,
      counts,
    })
  }

  setSuspendedTx(args: SetOrganizationSuspendedArgs): Promise<SetOrganizationSuspendedOutcome> {
    const org = this.organizations.get(args.organizationId)
    if (org === undefined || org.deletedAt !== null) return Promise.resolve("not_found")
    org.suspendedAt = args.suspended ? args.now : null
    org.suspendedReason = args.suspended ? args.reason : null
    org.updatedAt = args.now
    this.audits.push({
      actorId: args.actorId,
      action: args.suspended ? "org.suspended" : "org.unsuspended",
      target: `organization:${args.organizationId}`,
      meta: { reason: args.reason },
    })
    return Promise.resolve("updated")
  }

  adminListMembers(args: {
    organizationId: string
    cursor: string | null
    limit: number
  }): Promise<{ items: AdminOrgMemberRecord[]; nextCursor: string | null }> {
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
      items: page.map((m) => ({ user: this.actorOf(m.userId), role: m.role, joinedAt: m.joinedAt })),
      nextCursor: next === undefined ? null : `${next.joinedAt.toISOString()}|${next.userId}`,
    })
  }

  private demoteOwner(organizationId: string): string | null {
    const owner = this.members.find((m) => m.organizationId === organizationId && m.role === "owner")
    if (owner === undefined) return null
    owner.role = "admin"
    return owner.userId
  }

  adminAddMemberTx(args: AdminAddMemberArgs): Promise<AdminAddMemberOutcome> {
    const org = this.organizations.get(args.organizationId)
    if (org === undefined || org.deletedAt !== null) return Promise.resolve("not_found")
    const user = this.users.get(args.userId)
    if (user === undefined || user.deletedAt !== null) return Promise.resolve("user_not_found")
    const existing = this.members.find(
      (m) => m.organizationId === args.organizationId && m.userId === args.userId,
    )
    if (existing !== undefined) return Promise.resolve("already_member")
    const previousOwner = args.role === "owner" ? this.demoteOwner(args.organizationId) : null
    this.members.push({
      organizationId: args.organizationId,
      userId: args.userId,
      role: args.role,
      joinedAt: args.now,
    })
    this.audits.push({
      actorId: args.actorId,
      action: "org.member_added",
      target: `organization:${args.organizationId}`,
      meta: { targetUserId: args.userId, role: args.role, reason: args.reason },
    })
    if (args.role === "owner") {
      this.audits.push({
        actorId: args.actorId,
        action: "org.ownership_transferred",
        target: `organization:${args.organizationId}`,
        meta: { from: previousOwner, to: args.userId, reason: args.reason },
      })
    }
    return Promise.resolve("added")
  }

  adminSetMemberRoleTx(args: AdminSetMemberRoleArgs): Promise<AdminSetMemberRoleOutcome> {
    const member = this.members.find(
      (m) => m.organizationId === args.organizationId && m.userId === args.userId,
    )
    if (member === undefined) return Promise.resolve("not_member")
    if (member.role === args.role) return Promise.resolve("updated")
    if (member.role === "owner") return Promise.resolve("sole_owner")
    const from = member.role
    const previousOwner = args.role === "owner" ? this.demoteOwner(args.organizationId) : null
    member.role = args.role
    this.audits.push({
      actorId: args.actorId,
      action: "org.member_role_changed",
      target: `organization:${args.organizationId}`,
      meta: { targetUserId: args.userId, from, to: args.role, reason: args.reason },
    })
    if (args.role === "owner") {
      this.audits.push({
        actorId: args.actorId,
        action: "org.ownership_transferred",
        target: `organization:${args.organizationId}`,
        meta: { from: previousOwner, to: args.userId, reason: args.reason },
      })
    }
    return Promise.resolve("updated")
  }

  private expireInvites(organizationId: string, now: Date): void {
    for (const invite of this.invites) {
      if (
        invite.organizationId === organizationId &&
        invite.status === "pending" &&
        invite.expiresAt.getTime() <= now.getTime()
      ) {
        invite.status = "expired"
      }
    }
  }

  private personView(userId: string | null) {
    if (userId === null) return null
    const person = this.personOf(userId)
    return { id: person.id, displayName: person.displayName, handle: person.handle, bio: person.bio }
  }

  private toInviteRecord(invite: StoredInvite): OrganizationInviteRecord {
    return {
      id: invite.id,
      organizationId: invite.organizationId,
      email: invite.email,
      user: this.personView(invite.userId),
      role: invite.role,
      status: invite.status,
      invitedBy: this.personView(invite.invitedBy),
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
    }
  }

  countPendingInvites(organizationId: string, now: Date): Promise<number> {
    return Promise.resolve(
      this.invites.filter(
        (i) =>
          i.organizationId === organizationId &&
          i.status === "pending" &&
          i.expiresAt.getTime() > now.getTime(),
      ).length,
    )
  }

  createInviteTx(args: CreateOrganizationInviteArgs): Promise<CreateOrganizationInviteOutcome> {
    this.expireInvites(args.organizationId, args.now)
    const email = args.email.toLowerCase()
    const open = this.invites.find(
      (i) =>
        i.organizationId === args.organizationId &&
        i.status === "pending" &&
        i.email !== null &&
        i.email.toLowerCase() === email,
    )
    if (open !== undefined) return Promise.resolve({ kind: "already_invited" })
    const invite: StoredInvite = {
      id: args.inviteId,
      organizationId: args.organizationId,
      email: args.email,
      userId: null,
      role: args.role,
      status: "pending",
      tokenHash: args.tokenHash,
      invitedBy: args.invitedBy,
      createdAt: args.now,
      expiresAt: args.expiresAt,
      acceptedAt: null,
      revokedAt: null,
    }
    this.invites.push(invite)
    this.audits.push({
      actorId: args.invitedBy,
      action: "org.invite_created",
      target: `organization:${args.organizationId}`,
      meta: { inviteId: args.inviteId, role: args.role },
    })
    return Promise.resolve({ kind: "created", invite: this.toInviteRecord(invite) })
  }

  listInvites(organizationId: string, now: Date, limit: number): Promise<OrganizationInviteRecord[]> {
    this.expireInvites(organizationId, now)
    const rows = this.invites
      .filter((i) => i.organizationId === organizationId)
      .sort(
        (a, b) =>
          Number(b.status === "pending") - Number(a.status === "pending") ||
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b.id.localeCompare(a.id),
      )
      .slice(0, limit)
    return Promise.resolve(rows.map((i) => this.toInviteRecord(i)))
  }

  revokeInviteTx(args: {
    organizationId: string
    inviteId: string
    actorId: string
    now: Date
  }): Promise<RevokeOrganizationInviteOutcome> {
    const invite = this.invites.find(
      (i) =>
        i.id === args.inviteId &&
        i.organizationId === args.organizationId &&
        i.status === "pending",
    )
    if (invite === undefined) return Promise.resolve("not_found")
    invite.status = "revoked"
    invite.revokedAt = args.now
    this.audits.push({
      actorId: args.actorId,
      action: "org.invite_revoked",
      target: `organization:${args.organizationId}`,
      meta: { inviteId: args.inviteId },
    })
    return Promise.resolve("revoked")
  }

  acceptInviteTx(args: {
    tokenHash: string
    userId: string
    now: Date
  }): Promise<AcceptOrganizationInviteOutcome> {
    const invite = this.invites.find((i) => i.tokenHash === args.tokenHash)
    if (invite === undefined || invite.status !== "pending") return Promise.resolve({ kind: "invalid" })
    const org = this.organizations.get(invite.organizationId)
    if (org === undefined || org.deletedAt !== null) return Promise.resolve({ kind: "invalid" })
    if (invite.expiresAt.getTime() <= args.now.getTime()) {
      invite.status = "expired"
      return Promise.resolve({ kind: "expired" })
    }
    if (invite.email !== null) {
      const user = this.users.get(args.userId)
      if (
        user === undefined ||
        user.deletedAt !== null ||
        user.email === null ||
        user.email.toLowerCase() !== invite.email.toLowerCase()
      ) {
        return Promise.resolve({ kind: "wrong_recipient" })
      }
    }
    if (org.suspendedAt !== null) return Promise.resolve({ kind: "suspended" })
    const alreadyMember = this.members.some(
      (m) => m.organizationId === org.id && m.userId === args.userId,
    )
    if (!alreadyMember) {
      this.members.push({
        organizationId: org.id,
        userId: args.userId,
        role: invite.role,
        joinedAt: args.now,
      })
    }
    invite.status = "accepted"
    invite.acceptedAt = args.now
    invite.userId = args.userId
    this.audits.push({
      actorId: args.userId,
      action: "org.invite_accepted",
      target: `organization:${org.id}`,
      meta: { inviteId: invite.id, role: invite.role, alreadyMember },
    })
    return Promise.resolve({
      kind: "accepted",
      organizationId: org.id,
      role: invite.role,
      alreadyMember,
    })
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
