import { randomUUID } from "node:crypto"
import type { CleanupMemberRole, EventTeamInviteStatus, EventTeamRole } from "@civfix/shared"
import type { CleanupPersonView } from "../cleanup-repository.types.js"
import type {
  AcceptTeamInviteOutcome,
  CreateTeamInviteArgs,
  CreateTeamInviteOutcome,
  EventTeamInviteRecord,
  EventTeamMemberRecord,
  HostTeamRepository,
  RevokeTeamInviteOutcome,
} from "./host-team-repository.types.js"

interface StoredInvite {
  id: string
  cleanupId: string
  invitedUserId: string | null
  invitedEmail: string | null
  role: EventTeamRole
  tokenHash: string
  status: EventTeamInviteStatus
  invitedBy: string
  expiresAt: Date
  acceptedAt: Date | null
  emailScrubbedAt: Date | null
  createdAt: Date
}

interface StoredPerson {
  id: string
  displayName: string
  handle: string | null
  email: string | null
}

const ROLE_ORDER: Record<CleanupMemberRole, number> = {
  organizer: 0,
  cohost: 1,
  staff: 2,
  member: 3,
}

const TEAM_ROLE_RANK: Record<string, number> = { organizer: 4, cohost: 3, staff: 2, member: 1 }

function teamRoleRank(role: string): number {
  return TEAM_ROLE_RANK[role] ?? 0
}

export class InMemoryHostTeamRepository implements HostTeamRepository {
  readonly members: { cleanupId: string; userId: string; role: CleanupMemberRole; joinedAt: Date }[] =
    []
  readonly invites: StoredInvite[] = []
  readonly bans: { cleanupId: string; userId: string }[] = []
  readonly closedEvents = new Set<string>()
  readonly users = new Map<string, StoredPerson>()
  readonly audits: { actorId: string; action: string; target: string }[] = []

  seedUser(over: Partial<StoredPerson> = {}): StoredPerson {
    const person: StoredPerson = {
      id: over.id ?? randomUUID(),
      displayName: over.displayName ?? "Member",
      handle: over.handle ?? null,
      email: over.email ?? null,
    }
    this.users.set(person.id, person)
    return person
  }

  seedMember(
    cleanupId: string,
    userId: string,
    role: CleanupMemberRole,
    joinedAt: Date = new Date("2026-01-01T00:00:00.000Z"),
  ): void {
    if (!this.users.has(userId)) this.seedUser({ id: userId })
    const existing = this.members.find((m) => m.cleanupId === cleanupId && m.userId === userId)
    if (existing) existing.role = role
    else this.members.push({ cleanupId, userId, role, joinedAt })
  }

  seedBan(cleanupId: string, userId: string): void {
    this.bans.push({ cleanupId, userId })
  }

  private personOf(userId: string): CleanupPersonView {
    const stored = this.users.get(userId) ?? this.seedUser({ id: userId })
    return {
      id: stored.id,
      displayName: stored.displayName,
      handle: stored.handle,
      bio: null,
    }
  }

  private toInviteRecord(invite: StoredInvite): EventTeamInviteRecord {
    return {
      id: invite.id,
      cleanupId: invite.cleanupId,
      role: invite.role,
      status: invite.status,
      invitee: invite.invitedUserId === null ? null : this.personOf(invite.invitedUserId),
      invitedEmail: invite.invitedEmail,
      invitedBy: this.personOf(invite.invitedBy),
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      acceptedAt: invite.acceptedAt,
    }
  }

  listTeam(cleanupId: string, limit: number): Promise<EventTeamMemberRecord[]> {
    const rows = this.members
      .filter((m) => m.cleanupId === cleanupId && m.role !== "member")
      .sort(
        (a, b) =>
          ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
          a.joinedAt.getTime() - b.joinedAt.getTime() ||
          a.userId.localeCompare(b.userId),
      )
      .slice(0, limit)
      .map((m) => ({ person: this.personOf(m.userId), role: m.role, joinedAt: m.joinedAt }))
    return Promise.resolve(rows)
  }

  listInvites(cleanupId: string, limit: number): Promise<EventTeamInviteRecord[]> {
    const rows = this.invites
      .filter((i) => i.cleanupId === cleanupId && i.status === "pending")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((i) => this.toInviteRecord(i))
    return Promise.resolve(rows)
  }

  countPendingInvites(cleanupId: string): Promise<number> {
    return Promise.resolve(
      this.invites.filter((i) => i.cleanupId === cleanupId && i.status === "pending").length,
    )
  }

  resolveUserByHandle(handle: string): Promise<{ userId: string; email: string | null } | null> {
    const match = [...this.users.values()].find((u) => u.handle === handle)
    return Promise.resolve(match === undefined ? null : { userId: match.id, email: match.email })
  }

  createInviteTx(args: CreateTeamInviteArgs): Promise<CreateTeamInviteOutcome> {
    if (this.closedEvents.has(args.cleanupId)) return Promise.resolve({ kind: "closed" })
    if (args.invitedUserId !== null) {
      const member = this.members.find(
        (m) => m.cleanupId === args.cleanupId && m.userId === args.invitedUserId,
      )
      if (member !== undefined && member.role !== "member") {
        return Promise.resolve({ kind: "already_member", role: member.role })
      }
      const banned = this.bans.some(
        (b) => b.cleanupId === args.cleanupId && b.userId === args.invitedUserId,
      )
      if (banned) return Promise.resolve({ kind: "banned" })
    }
    const open = this.invites.find(
      (i) =>
        i.cleanupId === args.cleanupId &&
        i.status === "pending" &&
        ((i.invitedUserId !== null && i.invitedUserId === args.invitedUserId) ||
          (i.invitedEmail !== null && i.invitedEmail === args.invitedEmail)),
    )
    if (open !== undefined) return Promise.resolve({ kind: "already_invited" })
    const invite: StoredInvite = {
      id: args.inviteId,
      cleanupId: args.cleanupId,
      invitedUserId: args.invitedUserId,
      invitedEmail: args.invitedEmail,
      role: args.role,
      tokenHash: args.tokenHash,
      status: "pending",
      invitedBy: args.invitedBy,
      expiresAt: args.expiresAt,
      acceptedAt: null,
      emailScrubbedAt: null,
      createdAt: args.now,
    }
    this.invites.push(invite)
    this.audits.push({
      actorId: args.invitedBy,
      action: "event.team_invited",
      target: `cleanup:${args.cleanupId}`,
    })
    return Promise.resolve({ kind: "created", invite: this.toInviteRecord(invite) })
  }

  revokeInviteTx(args: {
    cleanupId: string
    inviteId: string
    actorId: string
  }): Promise<RevokeTeamInviteOutcome> {
    const invite = this.invites.find(
      (i) => i.id === args.inviteId && i.cleanupId === args.cleanupId && i.status === "pending",
    )
    if (invite === undefined) return Promise.resolve("not_found")
    invite.status = "revoked"
    invite.invitedEmail = null
    invite.emailScrubbedAt = new Date()
    this.audits.push({
      actorId: args.actorId,
      action: "event.team_invite_revoked",
      target: `cleanup:${args.cleanupId}`,
    })
    return Promise.resolve("revoked")
  }

  acceptInviteTx(args: {
    cleanupId: string
    tokenHash: string
    userId: string
    now: Date
  }): Promise<AcceptTeamInviteOutcome> {
    if (this.closedEvents.has(args.cleanupId)) return Promise.resolve({ kind: "closed" })
    const invite = this.invites.find(
      (i) => i.tokenHash === args.tokenHash && i.cleanupId === args.cleanupId,
    )
    if (invite === undefined || invite.status !== "pending") {
      return Promise.resolve({ kind: "invalid" })
    }
    if (invite.expiresAt.getTime() <= args.now.getTime()) {
      invite.status = "expired"
      invite.invitedEmail = null
      invite.emailScrubbedAt = args.now
      return Promise.resolve({ kind: "expired" })
    }
    if (invite.invitedUserId !== null && invite.invitedUserId !== args.userId) {
      return Promise.resolve({ kind: "wrong_recipient" })
    }
    if (invite.invitedUserId === null && invite.invitedEmail !== null) {
      if (this.users.get(args.userId)?.email !== invite.invitedEmail) {
        return Promise.resolve({ kind: "wrong_recipient" })
      }
    }
    if (this.bans.some((b) => b.cleanupId === args.cleanupId && b.userId === args.userId)) {
      return Promise.resolve({ kind: "banned" })
    }
    const existing = this.members.find(
      (m) => m.cleanupId === args.cleanupId && m.userId === args.userId,
    )
    if (existing === undefined) {
      this.members.push({
        cleanupId: args.cleanupId,
        userId: args.userId,
        role: invite.role,
        joinedAt: args.now,
      })
    } else if (existing.role !== "organizer" && teamRoleRank(invite.role) > teamRoleRank(existing.role)) {
      existing.role = invite.role
    }
    invite.status = "accepted"
    invite.acceptedAt = args.now
    invite.invitedEmail = null
    invite.emailScrubbedAt = args.now
    this.audits.push({
      actorId: args.userId,
      action: "event.team_role_changed",
      target: `cleanup:${args.cleanupId}`,
    })
    const role =
      this.members.find((m) => m.cleanupId === args.cleanupId && m.userId === args.userId)?.role ??
      invite.role
    return Promise.resolve({ kind: "accepted", role })
  }

  scrubInviteEmails(before: Date, limit: number): Promise<number> {
    let scrubbed = 0
    for (const invite of this.invites) {
      if (scrubbed >= limit) break
      if (
        invite.invitedEmail !== null &&
        invite.emailScrubbedAt === null &&
        invite.expiresAt.getTime() < before.getTime()
      ) {
        invite.invitedEmail = null
        invite.emailScrubbedAt = before
        scrubbed += 1
      }
    }
    return Promise.resolve(scrubbed)
  }

  expireStaleInvites(now: Date, limit: number): Promise<number> {
    let expired = 0
    for (const invite of this.invites) {
      if (expired >= limit) break
      if (invite.status === "pending" && invite.expiresAt.getTime() < now.getTime()) {
        invite.status = "expired"
        expired += 1
      }
    }
    return Promise.resolve(expired)
  }
}
