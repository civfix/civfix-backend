import type {
  CleanupMemberRole,
  CleanupStatus,
  EventTeamInviteStatus,
  EventTeamRole,
  EventVisibility,
} from "@civfix/shared"
import type { CleanupPersonView } from "../cleanup-repository.types.js"

export const TEAM_INVITE_CAP_MESSAGE =
  "This event already has the maximum number of open invitations."

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

export interface OpenTeamInviteQuery {
  cleanupId: string
  invitedUserId: string | null
  invitedEmail: string | null
}

export type CreateTeamInviteOutcome =
  | { kind: "created"; invite: EventTeamInviteRecord }
  | { kind: "already_member"; role: CleanupMemberRole }
  | { kind: "already_invited"; invite: EventTeamInviteRecord }
  | { kind: "updated"; invite: EventTeamInviteRecord }
  | { kind: "closed" }
  | { kind: "banned" }

export type RevokeTeamInviteOutcome = "revoked" | "not_found"

export type DeclineTeamInviteOutcome = "declined" | "not_found" | "not_pending"

export interface InviteEventView {
  id: string
  title: string
  startsAt: Date
  endsAt: Date | null
  status: CleanupStatus
  visibility: EventVisibility
  coverKey: string | null
  address: string | null
}

export interface PendingInviteForUserRecord {
  id: string
  role: EventTeamRole
  event: InviteEventView
  invitedBy: CleanupPersonView | null
  createdAt: Date
  expiresAt: Date
}

export interface ListInvitesForUserArgs {
  userId: string
  now: Date
  cursor: string | null
  limit: number
}

export type AcceptTeamInviteByIdOutcome =
  | { kind: "accepted"; cleanupId: string; role: CleanupMemberRole }
  | { kind: "not_found" }
  | { kind: "not_open" }
  | { kind: "expired" }
  | { kind: "closed" }
  | { kind: "banned" }

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
  findOpenInvite(query: OpenTeamInviteQuery): Promise<EventTeamInviteRecord | null>
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
  listInvitesForUser(
    args: ListInvitesForUserArgs,
  ): Promise<{ items: PendingInviteForUserRecord[]; nextCursor: string | null }>
  acceptInviteByIdTx(args: {
    inviteId: string
    userId: string
    now: Date
  }): Promise<AcceptTeamInviteByIdOutcome>
  declineInviteTx(args: {
    inviteId: string
    userId: string
    now: Date
  }): Promise<DeclineTeamInviteOutcome>
  scrubInviteEmails(before: Date, limit: number): Promise<number>
  expireStaleInvites(now: Date, limit: number): Promise<number>
}
