import type { CleanupMemberRole, EventTeamInviteStatus, EventTeamRole } from "@civfix/shared"
import type { CleanupPersonView } from "../cleanup-repository.types.js"

export interface EventTeamMemberRecord {
  person: CleanupPersonView
  role: CleanupMemberRole
  joinedAt: Date | null
}

export interface EventTeamInviteRecord {
  id: string
  cleanupId: string
  role: EventTeamRole
  status: EventTeamInviteStatus
  invitee: CleanupPersonView | null
  invitedEmail: string | null
  invitedBy: CleanupPersonView | null
  createdAt: Date
  expiresAt: Date
  acceptedAt: Date | null
}

export interface CreateTeamInviteArgs {
  inviteId: string
  cleanupId: string
  invitedUserId: string | null
  invitedEmail: string | null
  role: EventTeamRole
  tokenHash: string
  invitedBy: string
  expiresAt: Date
  now: Date
}

export type CreateTeamInviteOutcome =
  | { kind: "created"; invite: EventTeamInviteRecord }
  | { kind: "already_member"; role: CleanupMemberRole }
  | { kind: "already_invited" }
  | { kind: "closed" }
  | { kind: "banned" }

export type RevokeTeamInviteOutcome = "revoked" | "not_found"

export type AcceptTeamInviteOutcome =
  | { kind: "accepted"; role: CleanupMemberRole }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "closed" }
  | { kind: "wrong_recipient" }
  | { kind: "banned" }

export interface HostTeamRepository {
  listTeam(cleanupId: string, limit: number): Promise<EventTeamMemberRecord[]>
  listInvites(cleanupId: string, limit: number): Promise<EventTeamInviteRecord[]>
  countPendingInvites(cleanupId: string): Promise<number>
  resolveUserByHandle(handle: string): Promise<{ userId: string; email: string | null } | null>
  createInviteTx(args: CreateTeamInviteArgs): Promise<CreateTeamInviteOutcome>
  revokeInviteTx(args: {
    cleanupId: string
    inviteId: string
    actorId: string
  }): Promise<RevokeTeamInviteOutcome>
  acceptInviteTx(args: {
    cleanupId: string
    tokenHash: string
    userId: string
    now: Date
  }): Promise<AcceptTeamInviteOutcome>
  scrubInviteEmails(before: Date, limit: number): Promise<number>
  expireStaleInvites(now: Date, limit: number): Promise<number>
}
