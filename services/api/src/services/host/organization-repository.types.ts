import type {
  OrganizationMemberRole,
  OrgVerificationKind,
  OrgVerificationStatus,
  SocialLinks,
} from "@civfix/shared"
import type { CleanupPersonView } from "../cleanup-repository.types.js"

export interface OrganizationRecord {
  id: string
  slug: string
  name: string
  description: string | null
  websiteUrl: string | null
  logoMediaId: string | null
  logoKey: string | null
  socialLinks: SocialLinks | null
  verifiedStatus: OrgVerificationStatus
  verifiedKind: OrgVerificationKind | null
  verifiedAt: Date | null
  createdBy: string | null
  createdAt: Date
  deletedAt: Date | null
  memberCount: number
  eventCount: number
  myRole: OrganizationMemberRole | null
}

export interface OrganizationMemberRecord {
  person: CleanupPersonView
  role: OrganizationMemberRole
  joinedAt: Date
}

export interface OrgVerificationRecord {
  status: OrgVerificationStatus
  kind: OrgVerificationKind | null
  submittedAt: Date | null
  reviewedAt: Date | null
  rejectionReason: string | null
}

export interface AdminActorView {
  id: string
  name: string
  handle: string
  joined: Date
}

export interface AdminOrgVerificationRecord extends OrgVerificationRecord {
  id: string
  organizationId: string
  slug: string
  name: string
  einLast4: string | null
  documentMediaIds: string[]
  note: string | null
  submittedBy: AdminActorView | null
  reviewedBy: AdminActorView | null
}

export interface CreateOrganizationArgs {
  organizationId: string
  slug: string
  name: string
  description: string | null
  websiteUrl: string | null
  logoMediaId: string | null
  socialLinks: SocialLinks | null
  createdBy: string
  now: Date
}

export interface UpdateOrganizationPatch {
  name?: string
  description?: string | null
  websiteUrl?: string | null
  logoMediaId?: string | null
  socialLinks?: SocialLinks | null
}

export interface ApplyOrgVerificationArgs {
  verificationId: string
  organizationId: string
  kind: OrgVerificationKind
  einNumber: string | null
  documentMediaIds: string[]
  note: string | null
  submittedBy: string
  now: Date
}

export interface DecideOrgVerificationArgs {
  organizationId: string
  decision: "verified" | "rejected"
  kind: OrgVerificationKind | null
  reason: string | null
  reviewedBy: string
  now: Date
}

export interface OrgMemberIdentifier {
  identifierKind: "handle" | "email"
  identifier: string
}

export interface AdminOrgListQuery {
  status?: OrgVerificationStatus
  kind?: OrgVerificationKind
  q?: string
  cursor: string | null
  limit: number
}

export type AddOrganizationMemberOutcome = "added" | "already_member" | "user_not_found"

export type RemoveOrganizationMemberOutcome = "removed" | "not_member" | "owner"

export type SetOrganizationMemberRoleOutcome = "updated" | "not_member" | "owner"

export type DecideOrgVerificationOutcome = "decided" | "not_found" | "no_application"

export interface OrganizationRepository {
  createOrganizationTx(args: CreateOrganizationArgs): Promise<OrganizationRecord | "slug_taken">
  findOrganizationById(id: string, viewerId: string | null): Promise<OrganizationRecord | null>
  findOrganizationBySlug(slug: string, viewerId: string | null): Promise<OrganizationRecord | null>
  listMyOrganizations(userId: string, limit: number): Promise<OrganizationRecord[]>
  updateOrganizationTx(id: string, patch: UpdateOrganizationPatch, now: Date): Promise<boolean>
  roleOf(organizationId: string, userId: string): Promise<OrganizationMemberRole | null>
  listMembers(args: {
    organizationId: string
    cursor: string | null
    limit: number
  }): Promise<{ items: OrganizationMemberRecord[]; nextCursor: string | null }>
  resolveUserByIdentifier(identifier: OrgMemberIdentifier): Promise<string | null>
  addMemberTx(args: {
    organizationId: string
    userId: string
    role: "admin" | "member"
    actorId: string
    now: Date
  }): Promise<AddOrganizationMemberOutcome>
  setMemberRoleTx(args: {
    organizationId: string
    userId: string
    role: "admin" | "member"
    actorId: string
  }): Promise<SetOrganizationMemberRoleOutcome>
  removeMemberTx(args: {
    organizationId: string
    userId: string
    actorId: string
  }): Promise<RemoveOrganizationMemberOutcome>
  applyVerificationTx(args: ApplyOrgVerificationArgs): Promise<OrgVerificationRecord>
  getVerification(organizationId: string): Promise<OrgVerificationRecord | null>
  adminListVerifications(query: AdminOrgListQuery): Promise<{
    items: AdminOrgVerificationRecord[]
    nextCursor: string | null
    pendingCount: number
  }>
  adminGetVerification(organizationId: string): Promise<AdminOrgVerificationRecord | null>
  decideVerificationTx(args: DecideOrgVerificationArgs): Promise<DecideOrgVerificationOutcome>
  verifiedEinOf(organizationId: string): Promise<string | null>
  scrubDecidedEins(before: Date, limit: number): Promise<number>
}
