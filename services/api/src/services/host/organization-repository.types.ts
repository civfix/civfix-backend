import type {
  OrganizationInviteRole,
  OrganizationInviteStatus,
  OrganizationMemberRole,
  OrgVerificationKind,
  OrgVerificationStatus,
  SocialLinks,
} from "@civfix/shared"
import { can } from "@civfix/shared/host"
import type { CleanupOrganizationView, CleanupPersonView } from "../cleanup-repository.types.js"

export type InviterRevocationReason = "inviter_removed" | "inviter_demoted" | "account_deleted"

export function canManageOrgMembers(role: OrganizationMemberRole | null): boolean {
  return role !== null && can({ eventRole: null, orgRole: role }, "manage_org_members")
}

/**
 * A role change that takes away the power to invite withdraws the invites already sent with it, so
 * they stop showing up as open in the inviter's org and the invitee's inbox.
 */
export function roleChangeWithdrawsInvites(
  from: OrganizationMemberRole,
  to: OrganizationMemberRole,
): boolean {
  return canManageOrgMembers(from) && !canManageOrgMembers(to)
}

/** The inviter as the organization knows them at accept time; `null` when the account is gone. */
export interface InviterStanding {
  role: OrganizationMemberRole | null
  deleted: boolean
}

/**
 * An invite seats the role it names on the inviter's authority, so accepting re-checks that authority:
 * an invite that outlived it (sent concurrently with the demotion, or before revocation on demotion
 * existed) must not seat anyone. `null` means the inviter still holds it.
 */
export function inviterRevocationReason(
  inviter: InviterStanding | null,
): InviterRevocationReason | null {
  if (inviter === null) return "inviter_removed"
  if (inviter.deleted) return "account_deleted"
  if (inviter.role === null) return "inviter_removed"
  return canManageOrgMembers(inviter.role) ? null : "inviter_demoted"
}

export interface OrganizationBaseRecord {
  id: string
  slug: string
  name: string
  description: string | null
  websiteUrl: string | null
  donationUrl: string | null
  logoMediaId: string | null
  logoKey: string | null
  socialLinks: SocialLinks | null
  verifiedStatus: OrgVerificationStatus
  verifiedKind: OrgVerificationKind | null
  verifiedAt: Date | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
  /** Operator suspension flag (0162). NULL = not suspended. */
  suspendedAt: Date | null
  suspendedReason: string | null
  memberCount: number
  eventCount: number
  myRole: OrganizationMemberRole | null
}

export interface OrgHoursTotals {
  volunteerHours: number
  volunteerCount: number
}

export interface OrganizationRecord extends OrganizationBaseRecord, OrgHoursTotals {}

export interface OrganizationMemberRecord {
  person: CleanupPersonView
  role: OrganizationMemberRole
  joinedAt: Date
}

/** The organization's single owner (organization_members role='owner'), with the address to notify. */
export interface OrganizationOwnerRecord {
  userId: string
  displayName: string
  handle: string
  email: string | null
  joined: Date
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

/** Operator-facing extras on an org row: the owner, read in one query. */
export interface AdminOrganizationRecord extends OrganizationBaseRecord {
  owner: AdminActorView | null
}

export interface AdminOrganizationCounts {
  all: number
  verified: number
  pending: number
  suspended: number
}

export interface CreateOrganizationArgs {
  organizationId: string
  slug: string
  name: string
  description: string | null
  websiteUrl: string | null
  logoMediaId: string | null
  socialLinks: SocialLinks | null
  /** Recorded as organizations.created_by (the operator on the admin path). */
  createdBy: string
  /** The member seated as owner. Defaults to createdBy (the self-service path). */
  ownerUserId?: string
  /** Admin path only: create the org already verified as this kind (DECISIONS §32). */
  verifiedKind?: OrgVerificationKind | null
  /** Admin path only: the operator's mandatory audit reason; writes org.created + (when verified) the verification audit in the transaction. */
  operatorReason?: string
  now: Date
}

export interface UpdateOrganizationPatch {
  name?: string
  slug?: string
  description?: string | null
  websiteUrl?: string | null
  donationUrl?: string | null
  logoMediaId?: string | null
  socialLinks?: SocialLinks | null
}

export interface UpdateOrganizationAudit {
  actorId: string
  reason: string
  changed: string[]
}

export type UpdateOrganizationOutcome = "updated" | "not_found" | "slug_taken"

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

export interface AdminOrganizationListQuery {
  q?: string
  verified?: OrgVerificationStatus
  kind?: OrgVerificationKind
  suspended?: boolean
  cursor: string | null
  limit: number
}

export interface SetOrganizationSuspendedArgs {
  organizationId: string
  suspended: boolean
  reason: string
  actorId: string
  now: Date
}

export type SetOrganizationSuspendedOutcome = "updated" | "not_found"

export interface AdminOrgMemberRecord {
  user: AdminActorView
  role: OrganizationMemberRole
  joinedAt: Date
}

export interface AdminAddMemberArgs {
  organizationId: string
  userId: string
  role: OrganizationMemberRole
  actorId: string
  reason: string
  now: Date
}

export type AdminAddMemberOutcome = "added" | "already_member" | "user_not_found" | "not_found"

export interface AdminSetMemberRoleArgs {
  organizationId: string
  userId: string
  role: OrganizationMemberRole
  actorId: string
  reason: string
  now: Date
}

/** `sole_owner`: the target IS the owner and no transfer was requested — demotion needs a new owner first. */
export type AdminSetMemberRoleOutcome = "updated" | "not_member" | "sole_owner"

export interface OrganizationInviteRecord {
  id: string
  organizationId: string
  email: string | null
  user: CleanupPersonView | null
  role: OrganizationInviteRole
  status: OrganizationInviteStatus
  invitedBy: CleanupPersonView | null
  createdAt: Date
  expiresAt: Date
}

export interface CreateOrganizationInviteArgs {
  inviteId: string
  organizationId: string
  email: string
  /**
   * The verified account the address resolved to at invite time, when there is one. Recorded so the
   * accept/notification paths know who was meant, but the invite is STILL a pending record that this
   * account must accept: every email invite looks the same to the inviter (no account-existence oracle).
   */
  userId: string | null
  role: OrganizationInviteRole
  tokenHash: string
  invitedBy: string
  expiresAt: Date
  now: Date
}

/**
 * `already_invited` carries the open invite so the caller can answer with it (idempotent re-invite).
 * `forbidden`: the inviter no longer holds the power to invite once the organization is locked.
 */
export type CreateOrganizationInviteOutcome =
  | { kind: "created"; invite: OrganizationInviteRecord }
  | { kind: "already_invited"; invite: OrganizationInviteRecord }
  | { kind: "forbidden" }

export type RevokeOrganizationInviteOutcome = "revoked" | "not_found"

export type DeclineOrganizationInviteOutcome = "declined" | "invalid" | "expired"

/** One row of the invitee's own org-invite inbox (GET /me/org-invites). */
export interface PendingOrganizationInviteRecord {
  id: string
  role: OrganizationInviteRole
  createdAt: Date
  expiresAt: Date
  invitedBy: CleanupPersonView | null
  organization: CleanupOrganizationView
}

/** `role` is the SEATED role: for an existing member that is their current role, never an upgrade from the invite. */
export type AcceptOrganizationInviteOutcome =
  | {
      kind: "accepted"
      organizationId: string
      role: OrganizationMemberRole
      alreadyMember: boolean
    }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "wrong_recipient" }
  | { kind: "suspended" }

export type AddOrganizationMemberOutcome =
  | "added"
  | "already_member"
  | "user_not_found"
  | "forbidden"

export type RemoveOrganizationMemberOutcome = "removed" | "not_member" | "owner" | "last_admin"

export type SetOrganizationMemberRoleOutcome = "updated" | "not_member" | "owner" | "last_admin"

export type DecideOrgVerificationOutcome = "decided" | "not_found" | "no_application"

export interface OrganizationRepository {
  createOrganizationTx(args: CreateOrganizationArgs): Promise<OrganizationRecord | "slug_taken">
  findOrganizationById(id: string, viewerId: string | null): Promise<OrganizationRecord | null>
  findOrganizationBySlug(slug: string, viewerId: string | null): Promise<OrganizationRecord | null>
  listMyOrganizations(userId: string, limit: number): Promise<OrganizationRecord[]>
  updateOrganizationTx(
    id: string,
    patch: UpdateOrganizationPatch,
    now: Date,
    actorId: string,
    audit?: UpdateOrganizationAudit,
  ): Promise<UpdateOrganizationOutcome>
  roleOf(organizationId: string, userId: string): Promise<OrganizationMemberRole | null>
  listMembers(args: {
    organizationId: string
    cursor: string | null
    limit: number
  }): Promise<{ items: OrganizationMemberRecord[]; nextCursor: string | null }>
  findMember(organizationId: string, userId: string): Promise<OrganizationMemberRecord | null>
  findOwner(organizationId: string): Promise<OrganizationOwnerRecord | null>
  /** A live (non-deleted) account by id, in operator-facing shape. */
  findUser(userId: string): Promise<AdminActorView | null>
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
    reason?: string
  }): Promise<RemoveOrganizationMemberOutcome>
  applyVerificationTx(args: ApplyOrgVerificationArgs): Promise<OrgVerificationRecord>
  getVerification(organizationId: string): Promise<OrgVerificationRecord | null>
  adminListVerifications(query: AdminOrgListQuery): Promise<{
    items: AdminOrgVerificationRecord[]
    nextCursor: string | null
    pendingCount: number
  }>
  adminGetVerification(organizationId: string): Promise<AdminOrgVerificationRecord | null>
  /** Latest verification row per org, for list pages (one query, not N). */
  adminGetVerifications(organizationIds: string[]): Promise<Map<string, AdminOrgVerificationRecord>>
  decideVerificationTx(args: DecideOrgVerificationArgs): Promise<DecideOrgVerificationOutcome>
  scrubDecidedEins(before: Date, limit: number): Promise<number>

  // ---- Admin org management (0.41.0) ----
  adminFindOrganization(id: string): Promise<AdminOrganizationRecord | null>
  adminListOrganizations(query: AdminOrganizationListQuery): Promise<{
    items: AdminOrganizationRecord[]
    nextCursor: string | null
    counts: AdminOrganizationCounts | null
  }>
  setSuspendedTx(args: SetOrganizationSuspendedArgs): Promise<SetOrganizationSuspendedOutcome>
  adminListMembers(args: {
    organizationId: string
    cursor: string | null
    limit: number
  }): Promise<{ items: AdminOrgMemberRecord[]; nextCursor: string | null }>
  /** role=owner is an ownership transfer: the previous owner becomes admin in the same transaction. */
  adminAddMemberTx(args: AdminAddMemberArgs): Promise<AdminAddMemberOutcome>
  adminSetMemberRoleTx(args: AdminSetMemberRoleArgs): Promise<AdminSetMemberRoleOutcome>

  // ---- Org invites (0.41.0) ----
  countPendingInvites(organizationId: string, now: Date): Promise<number>
  createInviteTx(args: CreateOrganizationInviteArgs): Promise<CreateOrganizationInviteOutcome>
  /** Pending first, newest first; rows past expires_at are flipped to `expired` on the way out. */
  listInvites(organizationId: string, now: Date, limit: number): Promise<OrganizationInviteRecord[]>
  revokeInviteTx(args: {
    organizationId: string
    inviteId: string
    actorId: string
    now: Date
  }): Promise<RevokeOrganizationInviteOutcome>
  acceptInviteTx(args: {
    by: { tokenHash: string } | { inviteId: string }
    userId: string
    now: Date
  }): Promise<AcceptOrganizationInviteOutcome>
  /** The invitee's own open invites: addressed to their id OR their verified email. Bounded by `limit`. */
  listPendingInvitesForUser(args: {
    userId: string
    now: Date
    limit: number
  }): Promise<PendingOrganizationInviteRecord[]>
  declineInviteTx(args: {
    inviteId: string
    userId: string
    now: Date
  }): Promise<DeclineOrganizationInviteOutcome>
}
