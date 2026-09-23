import { randomUUID } from "node:crypto"
import { AppError, MAX_ORG_INVITES_PER_ORG } from "@civfix/shared"
import type {
  OrganizationInviteRole,
  OrganizationInviteStatus,
  OrganizationMemberRole,
  OrgVerificationKind,
  SocialLinks,
} from "@civfix/shared"
import type {
  AcceptOrganizationInviteOutcome,
  DeclineOrganizationInviteOutcome,
  PendingOrganizationInviteRecord,
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
  OrganizationBaseRecord,
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
  InviterRevocationReason,
  InviterStanding,
} from "./organization-repository.types.js"
import {
  canManageOrgMembers,
  inviterRevocationReason,
  roleChangeWithdrawsInvites,
} from "./organization-repository.types.js"
import { ORG_INVITE_CAP_MESSAGE } from "./organization-repository.types.js"
import { encodeTimeCursor } from "../../db/cursor-helpers.js"

const SEED_DISPLAY_NAME = "Member"

const SEED_CREATED_AT = "2025-01-01T00:00:00.000Z"

const OPERATOR_VERIFIED_NOTE = "Created verified by an operator."

interface StoredOrganization {
  id: string
  slug: string
  name: string
  description: string | null
  websiteUrl: string | null
  donationUrl: string | null
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
  /** Mirrors users.email_verified: an email invite is only resolvable by / acceptable with a VERIFIED address. */
  emailVerified: boolean
  bio: string | null
  avatarUrl: string | null
  createdAt: Date
  deletedAt: Date | null
}

/** Cursors here are `<ISO instant>|<id>` of the last row served; the page resumes right after it. */
function pageAfterCursor<T>(
  rows: readonly T[],
  cursor: string | null,
  limit: number,
  keyOf: (row: T) => string,
): { page: T[]; nextCursor: string | null } {
  const start = cursor === null ? 0 : rows.findIndex((row) => keyOf(row) === cursor) + 1
  const page = rows.slice(start, start + limit)
  const next = rows.length > start + limit ? page[page.length - 1] : undefined
  return { page, nextCursor: next === undefined ? null : keyOf(next) }
}

function memberCursorKey(member: StoredMember): string {
  return encodeTimeCursor({ at: member.joinedAt, id: member.userId })
}

export class InMemoryOrganizationRepository implements OrganizationRepository {
  readonly organizations = new Map<string, StoredOrganization>()
  readonly members: StoredMember[] = []
  readonly verifications: StoredVerification[] = []
  readonly invites: StoredInvite[] = []
  readonly users = new Map<string, StoredPerson>()
  readonly eventCounts = new Map<string, number>()
  readonly volunteerHours = new Map<string, { hours: number; volunteers: number }>()
  readonly audits: {
    actorId: string
    action: string
    target: string
    meta?: Record<string, unknown>
  }[] = []

  seedUser(over: Partial<StoredPerson> = {}): StoredPerson {
    const person: StoredPerson = {
      id: over.id ?? randomUUID(),
      displayName: over.displayName ?? SEED_DISPLAY_NAME,
      handle: over.handle ?? null,
      email: over.email ?? null,
      emailVerified: over.emailVerified ?? true,
      bio: over.bio ?? null,
      avatarUrl: over.avatarUrl ?? null,
      createdAt: over.createdAt ?? new Date(SEED_CREATED_AT),
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

  private toBaseRecord(org: StoredOrganization, viewerId: string | null): OrganizationBaseRecord {
    return {
      id: org.id,
      slug: org.slug,
      name: org.name,
      description: org.description,
      websiteUrl: org.websiteUrl,
      donationUrl: org.donationUrl,
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

  private toRecord(org: StoredOrganization, viewerId: string | null): OrganizationRecord {
    const totals = this.volunteerHours.get(org.id)
    return {
      ...this.toBaseRecord(org, viewerId),
      volunteerHours: totals?.hours ?? 0,
      volunteerCount: totals?.volunteers ?? 0,
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
      donationUrl: null,
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
        note: OPERATOR_VERIFIED_NOTE,
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
        meta: {
          kind: verifiedKind,
          reason: args.operatorReason ?? null,
          source: "operator_create",
        },
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

  findOrganizationBySlug(
    slug: string,
    viewerId: string | null,
  ): Promise<OrganizationRecord | null> {
    const org = [...this.organizations.values()].find(
      (o) => o.slug === slug && o.deletedAt === null,
    )
    return Promise.resolve(org === undefined ? null : this.toRecord(org, viewerId))
  }

  listMyOrganizations(userId: string, limit: number): Promise<OrganizationRecord[]> {
    const ids = new Set(
      this.members.filter((m) => m.userId === userId).map((m) => m.organizationId),
    )
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
    _actorId: string,
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
    if (patch.donationUrl !== undefined) org.donationUrl = patch.donationUrl
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

  private membersByJoinOrder(organizationId: string): StoredMember[] {
    return this.members
      .filter((m) => m.organizationId === organizationId)
      .sort(
        (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || a.userId.localeCompare(b.userId),
      )
  }

  private toMemberRecord(member: StoredMember): OrganizationMemberRecord {
    const person = this.personOf(member.userId)
    return {
      person: {
        id: person.id,
        displayName: person.displayName,
        handle: person.handle,
        bio: person.bio,
        avatarUrl: person.avatarUrl,
      },
      role: member.role,
      joinedAt: member.joinedAt,
    }
  }

  listMembers(args: {
    organizationId: string
    cursor: string | null
    limit: number
  }): Promise<{ items: OrganizationMemberRecord[]; nextCursor: string | null }> {
    const { page, nextCursor } = pageAfterCursor(
      this.membersByJoinOrder(args.organizationId),
      args.cursor,
      args.limit,
      memberCursorKey,
    )
    return Promise.resolve({ items: page.map((m) => this.toMemberRecord(m)), nextCursor })
  }

  findMember(organizationId: string, userId: string): Promise<OrganizationMemberRecord | null> {
    const member = this.members.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    )
    return Promise.resolve(member === undefined ? null : this.toMemberRecord(member))
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
    // Same rules as the drizzle repo: live accounts only, and an email (citext) resolves only when verified.
    const match = [...this.users.values()].find(
      (u) =>
        u.deletedAt === null &&
        (identifier.identifierKind === "handle"
          ? u.handle === identifier.identifier
          : u.emailVerified &&
            u.email !== null &&
            u.email.toLowerCase() === identifier.identifier.toLowerCase()),
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
    if (!this.managesMembers(args.organizationId, args.actorId)) {
      return Promise.resolve("forbidden")
    }
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
      action: "org.member_added",
      target: `organization:${args.organizationId}`,
    })
    return Promise.resolve("added")
  }

  private managesMembers(organizationId: string, userId: string): boolean {
    const seat = this.members.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    )
    return canManageOrgMembers(seat?.role ?? null)
  }

  private inviterStanding(
    organizationId: string,
    inviterId: string | null,
  ): InviterStanding | null {
    if (inviterId === null) return null
    const inviter = this.users.get(inviterId)
    if (inviter === undefined) return null
    const seat = this.members.find(
      (m) => m.organizationId === organizationId && m.userId === inviterId,
    )
    return { role: seat?.role ?? null, deleted: inviter.deletedAt !== null }
  }

  private countAdminSeats(organizationId: string): number {
    return this.members.filter(
      (m) => m.organizationId === organizationId && (m.role === "owner" || m.role === "admin"),
    ).length
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
    if (member.role === "admin" && args.role === "member") {
      if (this.countAdminSeats(args.organizationId) <= 1) return Promise.resolve("last_admin")
    }
    if (member.role !== args.role) {
      const from = member.role
      member.role = args.role
      this.audits.push({
        actorId: args.actorId,
        action: "org.member_role_changed",
        target: `organization:${args.organizationId}`,
      })
      if (roleChangeWithdrawsInvites(from, args.role)) {
        this.revokeInvitesByInviter(
          args.organizationId,
          args.userId,
          args.actorId,
          "inviter_demoted",
        )
      }
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
    if (member.role === "admin" && this.countAdminSeats(args.organizationId) <= 1) {
      return Promise.resolve("last_admin")
    }
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
    this.revokeInvitesByInviter(args.organizationId, args.userId, args.actorId, "inviter_removed")
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
      submittedBy: row.submittedBy === null ? null : this.actorOf(row.submittedBy),
      reviewedBy: row.reviewedBy === null ? null : this.actorOf(row.reviewedBy),
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
    const { page, nextCursor } = pageAfterCursor(rows, query.cursor, query.limit, (v) =>
      encodeTimeCursor({ at: v.submittedAt, id: v.id }),
    )
    return Promise.resolve({
      items: page.map((row) => this.toAdminRecord(row)),
      nextCursor,
      pendingCount: this.verifications.filter((v) => v.status === "pending").length,
    })
  }

  adminGetVerification(organizationId: string): Promise<AdminOrgVerificationRecord | null> {
    const row = this.latestFor(organizationId)
    return Promise.resolve(row === undefined ? null : this.toAdminRecord(row))
  }

  adminGetVerifications(
    organizationIds: string[],
  ): Promise<Map<string, AdminOrgVerificationRecord>> {
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
      ...this.toBaseRecord(org, null),
      owner: owner === undefined ? null : this.actorOf(owner.userId),
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
      .filter((o) => query.suspended === undefined || (o.suspendedAt !== null) === query.suspended)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
    const { page, nextCursor } = pageAfterCursor(rows, query.cursor, query.limit, (o) =>
      encodeTimeCursor({ at: o.createdAt, id: o.id }),
    )
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
      nextCursor,
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
    const { page, nextCursor } = pageAfterCursor(
      this.membersByJoinOrder(args.organizationId),
      args.cursor,
      args.limit,
      memberCursorKey,
    )
    return Promise.resolve({
      items: page.map((m) => ({
        user: this.actorOf(m.userId),
        role: m.role,
        joinedAt: m.joinedAt,
      })),
      nextCursor,
    })
  }

  private demoteOwner(organizationId: string): string | null {
    const owner = this.members.find(
      (m) => m.organizationId === organizationId && m.role === "owner",
    )
    if (owner === undefined) return null
    owner.role = "admin"
    return owner.userId
  }

  private auditOwnershipTransfer(
    args: { organizationId: string; userId: string; actorId: string; reason: string },
    previousOwner: string | null,
  ): void {
    this.audits.push({
      actorId: args.actorId,
      action: "org.ownership_transferred",
      target: `organization:${args.organizationId}`,
      meta: { from: previousOwner, to: args.userId, reason: args.reason },
    })
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
    if (args.role === "owner") this.auditOwnershipTransfer(args, previousOwner)
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
    if (roleChangeWithdrawsInvites(from, args.role)) {
      this.revokeInvitesByInviter(args.organizationId, args.userId, args.actorId, "inviter_demoted")
    }
    if (args.role === "owner") this.auditOwnershipTransfer(args, previousOwner)
    return Promise.resolve("updated")
  }

  private revokeInvitesByInviter(
    organizationId: string,
    inviterId: string,
    actorId: string,
    reason: InviterRevocationReason,
  ): void {
    for (const invite of this.invites) {
      if (
        invite.organizationId !== organizationId ||
        invite.invitedBy !== inviterId ||
        invite.status !== "pending"
      ) {
        continue
      }
      invite.status = "revoked"
      invite.revokedAt = new Date()
      this.audits.push({
        actorId,
        action: "org.invite_revoked",
        target: `organization:${organizationId}`,
        meta: { inviteId: invite.id, reason },
      })
    }
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
    return {
      id: person.id,
      displayName: person.displayName,
      handle: person.handle,
      bio: person.bio,
      avatarUrl: person.avatarUrl,
    }
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

  private openInviteCount(organizationId: string, now: Date): number {
    return this.invites.filter(
      (i) =>
        i.organizationId === organizationId &&
        i.status === "pending" &&
        i.expiresAt.getTime() > now.getTime(),
    ).length
  }

  countPendingInvites(organizationId: string, now: Date): Promise<number> {
    return Promise.resolve(this.openInviteCount(organizationId, now))
  }

  createInviteTx(args: CreateOrganizationInviteArgs): Promise<CreateOrganizationInviteOutcome> {
    if (!this.managesMembers(args.organizationId, args.invitedBy)) {
      return Promise.resolve({ kind: "forbidden" })
    }
    this.expireInvites(args.organizationId, args.now)
    if (this.openInviteCount(args.organizationId, args.now) >= MAX_ORG_INVITES_PER_ORG) {
      return Promise.reject(AppError.conflict(ORG_INVITE_CAP_MESSAGE))
    }
    const email = args.email.toLowerCase()
    const open = this.invites.find(
      (i) =>
        i.organizationId === args.organizationId &&
        i.status === "pending" &&
        i.email !== null &&
        i.email.toLowerCase() === email,
    )
    if (open !== undefined) {
      return Promise.resolve({ kind: "already_invited", invite: this.toInviteRecord(open) })
    }
    const invite: StoredInvite = {
      id: args.inviteId,
      organizationId: args.organizationId,
      email: args.email,
      userId: args.userId,
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

  listInvites(
    organizationId: string,
    now: Date,
    limit: number,
  ): Promise<OrganizationInviteRecord[]> {
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

  /** The drizzle rule verbatim: the row names this account, or carries an address it has verified. */
  private inviteAddressesUser(
    invite: { email: string | null; userId: string | null },
    userId: string,
  ): boolean {
    if (invite.userId !== null && invite.userId === userId) return true
    if (invite.email === null) return false
    const user = this.users.get(userId)
    return (
      user !== undefined &&
      user.deletedAt === null &&
      user.email !== null &&
      user.emailVerified &&
      user.email.toLowerCase() === invite.email.toLowerCase()
    )
  }

  listPendingInvitesForUser(args: {
    userId: string
    now: Date
    limit: number
  }): Promise<PendingOrganizationInviteRecord[]> {
    const out: PendingOrganizationInviteRecord[] = []
    for (const invite of [...this.invites].reverse()) {
      if (invite.status !== "pending") continue
      if (invite.expiresAt.getTime() <= args.now.getTime()) continue
      const org = this.organizations.get(invite.organizationId)
      if (org === undefined || org.deletedAt !== null || org.suspendedAt !== null) continue
      if (this.members.some((m) => m.organizationId === org.id && m.userId === args.userId)) {
        continue
      }
      if (!this.inviteAddressesUser(invite, args.userId)) continue
      const inviter = invite.invitedBy === null ? null : this.personOf(invite.invitedBy)
      out.push({
        id: invite.id,
        role: invite.role,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        invitedBy: inviter,
        organization: {
          id: org.id,
          slug: org.slug,
          name: org.name,
          logoKey: null,
          donationUrl: null,
          verifiedStatus: org.verifiedStatus,
          verifiedKind: org.verifiedKind,
          suspended: false,
        },
      })
      if (out.length >= args.limit) break
    }
    return Promise.resolve(out)
  }

  declineInviteTx(args: {
    inviteId: string
    userId: string
    now: Date
  }): Promise<DeclineOrganizationInviteOutcome> {
    const invite = this.invites.find((i) => i.id === args.inviteId)
    if (invite === undefined || invite.status !== "pending") return Promise.resolve("invalid")
    if (!this.inviteAddressesUser(invite, args.userId)) return Promise.resolve("invalid")
    if (invite.expiresAt.getTime() <= args.now.getTime()) {
      invite.status = "expired"
      return Promise.resolve("expired")
    }
    invite.status = "declined"
    invite.userId = args.userId
    this.audits.push({
      actorId: args.userId,
      action: "org.invite_declined",
      target: `organization:${invite.organizationId}`,
      meta: { inviteId: invite.id },
    })
    return Promise.resolve("declined")
  }

  acceptInviteTx(args: {
    by: { tokenHash: string } | { inviteId: string }
    userId: string
    now: Date
  }): Promise<AcceptOrganizationInviteOutcome> {
    const by = args.by
    const byToken = "tokenHash" in by
    const invite = byToken
      ? this.invites.find((i) => i.tokenHash === by.tokenHash)
      : this.invites.find((i) => i.id === by.inviteId)
    if (invite === undefined || invite.status !== "pending")
      return Promise.resolve({ kind: "invalid" })
    const org = this.organizations.get(invite.organizationId)
    if (org === undefined || org.deletedAt !== null) return Promise.resolve({ kind: "invalid" })
    if (invite.expiresAt.getTime() <= args.now.getTime()) {
      invite.status = "expired"
      return Promise.resolve({ kind: "expired" })
    }
    const addressed = this.inviteAddressesUser(invite, args.userId)
    if (byToken ? invite.email !== null && !addressed : !addressed) {
      return Promise.resolve({ kind: "wrong_recipient" })
    }
    const revocation = inviterRevocationReason(this.inviterStanding(org.id, invite.invitedBy))
    if (revocation !== null) {
      invite.status = "revoked"
      invite.revokedAt = args.now
      this.audits.push({
        actorId: args.userId,
        action: "org.invite_revoked",
        target: `organization:${org.id}`,
        meta: { inviteId: invite.id, reason: revocation },
      })
      return Promise.resolve({ kind: "invalid" })
    }
    if (org.suspendedAt !== null) return Promise.resolve({ kind: "suspended" })
    const existing = this.members.find(
      (m) => m.organizationId === org.id && m.userId === args.userId,
    )
    const alreadyMember = existing !== undefined
    // An existing member keeps their seated role: accepting never upgrades (or downgrades) it.
    const role: OrganizationMemberRole = existing?.role ?? invite.role
    if (existing === undefined) {
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
      meta: { inviteId: invite.id, role, alreadyMember },
    })
    return Promise.resolve({
      kind: "accepted",
      organizationId: org.id,
      role,
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
    this.audits.push({
      actorId: args.reviewedBy,
      action:
        args.decision === "verified" ? "org.verification_verified" : "org.verification_rejected",
      target: `organization:${args.organizationId}`,
      meta: { kind: grantedKind, reason: args.reason },
    })
    return Promise.resolve("decided")
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
