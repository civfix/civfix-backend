import type { OrganizationMemberRole } from "@civfix/shared"
import { can } from "@civfix/shared/host"

export type InviterRevocationReason = "inviter_removed" | "inviter_demoted" | "account_deleted"

export function canManageOrgMembers(role: OrganizationMemberRole | null): boolean {
  return role !== null && can({ eventRole: null, orgRole: role }, "manage_org_members")
}

export const ORG_INVITE_CAP_MESSAGE =
  "This organization already has the maximum number of open invitations."

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
