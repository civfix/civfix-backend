import { randomUUID } from "node:crypto"
import type {
  CleanupMemberRole,
  CleanupStatus,
  EventTeamInviteStatus,
  EventTeamRole,
  EventVisibility,
} from "@civfix/shared"
import { encodeTimeCursor, pageWith, parseTimeCursor } from "../../db/cursor-helpers.js"
import type { CleanupPersonView } from "../cleanup-repository.types.js"
import type {
  AcceptTeamInviteByIdOutcome,
  AcceptTeamInviteOutcome,
  CreateTeamInviteArgs,
  CreateTeamInviteOutcome,
  DeclineTeamInviteOutcome,
  EventTeamInviteRecord,
  EventTeamMemberRecord,
  HostTeamRepository,
  InviteEventView,
  ListInvitesForUserArgs,
  OpenTeamInviteQuery,
  PendingInviteForUserRecord,
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
  coordinator: 2,
  staff: 3,
  member: 4,
}

const TEAM_ROLE_RANK: Record<string, number> = {
  organizer: 5,
  cohost: 4,
  coordinator: 3,
  staff: 2,
  member: 1,
}

const CLOSED_EVENT_STATUSES: CleanupStatus[] = ["cancelled", "done"]

function teamRoleRank(role: string): number {
  return TEAM_ROLE_RANK[role] ?? 0
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export class InMemoryHostTeamRepository implements HostTeamRepository {
  readonly members: { cleanupId: string; userId: string; role: CleanupMemberRole; joinedAt: Date }[] =
    []
  readonly invites: StoredInvite[] = []
  readonly bans: { cleanupId: string; userId: string }[] = []
  readonly closedEvents = new Set<string>()
  readonly events = new Map<string, InviteEventView>()
  readonly users = new Map<string, StoredPerson>()
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

  seedEvent(cleanupId: string, over: Partial<InviteEventView> = {}): InviteEventView {
    const event: InviteEventView = {
      id: cleanupId,
      title: over.title ?? "Beach cleanup",
      startsAt: over.startsAt ?? new Date("2026-10-01T17:00:00.000Z"),
      endsAt: over.endsAt ?? null,
      status: over.status ?? ("upcoming" as CleanupStatus),
      visibility: over.visibility ?? ("public" as EventVisibility),
      coverKey: over.coverKey ?? null,
      address: over.address ?? null,
    }
    this.events.set(cleanupId, event)
    return event
  }

  private eventOf(cleanupId: string): InviteEventView {
    const event = this.events.get(cleanupId) ?? this.seedEvent(cleanupId)
    return this.closedEvents.has(cleanupId) ? { ...event, status: "cancelled" } : { ...event }
  }

  private isClosed(cleanupId: string): boolean {
    return CLOSED_EVENT_STATUSES.includes(this.eventOf(cleanupId).status)
  }

  seedBan(cleanupId: string, userId: string): void {
    this.bans.push({ cleanupId, userId })
  }

  private personOf(userId: string): CleanupPersonView | null {
    const stored = this.users.get(userId)
    if (stored === undefined) return null
    return {
      id: stored.id,
      displayName: stored.displayName,
      handle: stored.handle,
      bio: null,
    }
  }

  private seatMember(
    cleanupId: string,
    userId: string,
    role: EventTeamRole,
    now: Date,
  ): CleanupMemberRole {
    const existing = this.members.find((m) => m.cleanupId === cleanupId && m.userId === userId)
    if (existing === undefined) {
      this.members.push({ cleanupId, userId, role, joinedAt: now })
      return role
    }
    if (existing.role !== "organizer" && teamRoleRank(role) > teamRoleRank(existing.role)) {
      existing.role = role
    }
    return existing.role
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
          compareIds(a.userId, b.userId),
      )
      .flatMap((m) => {
        const person = this.personOf(m.userId)
        return person === null ? [] : [{ person, role: m.role, joinedAt: m.joinedAt }]
      })
      .slice(0, limit)
    return Promise.resolve(rows)
  }

  listInvites(cleanupId: string, limit: number): Promise<EventTeamInviteRecord[]> {
    const rows = this.invites
      .filter((i) => i.cleanupId === cleanupId && i.status === "pending")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareIds(b.id, a.id))
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

  private openInviteFor(args: OpenTeamInviteQuery): StoredInvite | undefined {
    return [...this.invites]
      .reverse()
      .find(
        (i) =>
          i.cleanupId === args.cleanupId &&
          i.status === "pending" &&
          ((i.invitedUserId !== null && i.invitedUserId === args.invitedUserId) ||
            (i.invitedEmail !== null && i.invitedEmail === args.invitedEmail)),
      )
  }

  findOpenInvite(query: OpenTeamInviteQuery): Promise<EventTeamInviteRecord | null> {
    const open = this.openInviteFor(query)
    return Promise.resolve(open === undefined ? null : this.toInviteRecord(open))
  }

  createInviteTx(args: CreateTeamInviteArgs): Promise<CreateTeamInviteOutcome> {
    if (this.isClosed(args.cleanupId)) return Promise.resolve({ kind: "closed" })
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
    const open = this.openInviteFor(args)
    if (open !== undefined) {
      if (open.role === args.role) {
        return Promise.resolve({ kind: "already_invited", invite: this.toInviteRecord(open) })
      }
      const from = open.role
      open.role = args.role
      this.audits.push({
        actorId: args.invitedBy,
        action: "event.team_role_changed",
        target: `cleanup:${args.cleanupId}`,
        meta: { inviteId: open.id, from, to: args.role },
      })
      return Promise.resolve({ kind: "updated", invite: this.toInviteRecord(open) })
    }
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
    if (this.isClosed(args.cleanupId)) return Promise.resolve({ kind: "closed" })
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
    const seated = this.seatMember(args.cleanupId, args.userId, invite.role, args.now)
    invite.status = "accepted"
    invite.acceptedAt = args.now
    invite.invitedEmail = null
    invite.emailScrubbedAt = args.now
    this.audits.push({
      actorId: args.userId,
      action: "event.team_role_changed",
      target: `cleanup:${args.cleanupId}`,
    })
    return Promise.resolve({ kind: "accepted", role: seated })
  }

  listInvitesForUser(
    args: ListInvitesForUserArgs,
  ): Promise<{ items: PendingInviteForUserRecord[]; nextCursor: string | null }> {
    const cursor = parseTimeCursor(args.cursor)
    const rows = this.invites
      .filter(
        (i) =>
          i.invitedUserId === args.userId &&
          i.status === "pending" &&
          i.expiresAt.getTime() > args.now.getTime() &&
          !this.isClosed(i.cleanupId),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareIds(b.id, a.id))
      .filter(
        (i) =>
          cursor === null ||
          i.createdAt.getTime() < cursor.at.getTime() ||
          (i.createdAt.getTime() === cursor.at.getTime() && i.id < cursor.id),
      )
      .slice(0, args.limit + 1)
      .map(
        (i): PendingInviteForUserRecord => ({
          id: i.id,
          role: i.role,
          event: this.eventOf(i.cleanupId),
          invitedBy: this.personOf(i.invitedBy),
          createdAt: i.createdAt,
          expiresAt: i.expiresAt,
        }),
      )
    return Promise.resolve(
      pageWith(rows, args.limit, (last) =>
        encodeTimeCursor({ at: last.createdAt, id: last.id }),
      ),
    )
  }

  acceptInviteByIdTx(args: {
    inviteId: string
    userId: string
    now: Date
  }): Promise<AcceptTeamInviteByIdOutcome> {
    const invite = this.invites.find(
      (i) => i.id === args.inviteId && i.invitedUserId === args.userId,
    )
    if (invite === undefined) return Promise.resolve({ kind: "not_found" })
    const cleanupId = invite.cleanupId
    if (invite.status === "accepted") {
      const held = this.members.find(
        (m) => m.cleanupId === cleanupId && m.userId === args.userId,
      )?.role
      return Promise.resolve(
        held === undefined ? { kind: "not_open" } : { kind: "accepted", cleanupId, role: held },
      )
    }
    if (invite.status !== "pending") return Promise.resolve({ kind: "not_open" })
    if (this.isClosed(cleanupId)) return Promise.resolve({ kind: "closed" })
    if (invite.expiresAt.getTime() <= args.now.getTime()) {
      invite.status = "expired"
      invite.invitedEmail = null
      invite.emailScrubbedAt = args.now
      return Promise.resolve({ kind: "expired" })
    }
    if (this.bans.some((b) => b.cleanupId === cleanupId && b.userId === args.userId)) {
      return Promise.resolve({ kind: "banned" })
    }
    const role = this.seatMember(cleanupId, args.userId, invite.role, args.now)
    invite.status = "accepted"
    invite.acceptedAt = args.now
    invite.invitedEmail = null
    invite.emailScrubbedAt = args.now
    this.audits.push({
      actorId: args.userId,
      action: "event.team_role_changed",
      target: `cleanup:${cleanupId}`,
    })
    return Promise.resolve({ kind: "accepted", cleanupId, role })
  }

  declineInviteTx(args: {
    inviteId: string
    userId: string
    now: Date
  }): Promise<DeclineTeamInviteOutcome> {
    const invite = this.invites.find(
      (i) => i.id === args.inviteId && i.invitedUserId === args.userId,
    )
    if (invite === undefined) return Promise.resolve("not_found")
    if (invite.status !== "pending") return Promise.resolve("not_pending")
    invite.status = "declined"
    invite.invitedEmail = null
    invite.emailScrubbedAt = args.now
    this.audits.push({
      actorId: args.userId,
      action: "event.team_invite_declined",
      target: `cleanup:${invite.cleanupId}`,
    })
    return Promise.resolve("declined")
  }

  private byExpiryAsc(match: (invite: StoredInvite) => boolean, limit: number): StoredInvite[] {
    return this.invites
      .filter(match)
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || compareIds(a.id, b.id))
      .slice(0, limit)
  }

  scrubInviteEmails(before: Date, limit: number): Promise<number> {
    const due = this.byExpiryAsc(
      (invite) =>
        invite.invitedEmail !== null &&
        invite.emailScrubbedAt === null &&
        invite.expiresAt.getTime() < before.getTime(),
      limit,
    )
    for (const invite of due) {
      invite.invitedEmail = null
      invite.emailScrubbedAt = before
    }
    return Promise.resolve(due.length)
  }

  expireStaleInvites(now: Date, limit: number): Promise<number> {
    const due = this.byExpiryAsc(
      (invite) => invite.status === "pending" && invite.expiresAt.getTime() <= now.getTime(),
      limit,
    )
    for (const invite of due) invite.status = "expired"
    return Promise.resolve(due.length)
  }
}
