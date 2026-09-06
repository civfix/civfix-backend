import { randomUUID } from "node:crypto"
import {
  AppError,
  MAX_TEAM_INVITES_PER_EVENT,
  type AcceptEventTeamInviteResponse,
  type EventTeamInviteDTO,
  type EventTeamMemberDTO,
  type InviteEventTeamMemberRequest,
  type HostCapability,
  type ListEventTeamResponse,
} from "@civfix/shared"
import { can } from "@civfix/shared/host"
import { InMemoryCounterStore, type CounterStore } from "../../abuse/counter-store.js"
import { generateToken, sha256Hex } from "../../auth/crypto.js"
import { toAttendeePersonDTO } from "../cleanup-dto.js"
import { requireCapability } from "./authz.js"
import type { HostStandingResolution } from "./host-standing.js"
import type {
  EventTeamInviteRecord,
  EventTeamMemberRecord,
  HostTeamRepository,
} from "./host-team-repository.types.js"

export const TEAM_INVITES_PER_EVENT_PER_DAY = 30
const TEAM_INVITE_WINDOW_SEC = 24 * 60 * 60

export const TEAM_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000

export const TEAM_INVITE_EMAIL_SCRUB_DELAY_MS = 7 * 24 * 60 * 60 * 1000

export const TEAM_MEMBER_CAP = 200

export const TEAM_INVITE_LIST_CAP = 100

export const TEAM_INVITE_TOKEN_BYTES = 32

const fallbackCounters = new InMemoryCounterStore()

export interface HostTeamMailer {
  sendTransactional(to: string, template: string, vars: Record<string, unknown>): Promise<void>
}

export interface HostTeamStandingLookup {
  (
    cleanupId: string,
    userId: string,
    capability: HostCapability,
  ): Promise<HostStandingResolution>
}

export interface HostTeamServiceDeps {
  repo: HostTeamRepository
  standing: HostTeamStandingLookup
  counters?: CounterStore
  mailer?: HostTeamMailer
  eventTitleOf?: (cleanupId: string) => Promise<string | null>
  webOrigin?: string
  logger?: { warn(obj: unknown, msg?: string): void }
  now?: () => Date
  newId?: () => string
  newToken?: () => string
}

export interface HostTeamService {
  listTeam(cleanupId: string, actorId: string): Promise<ListEventTeamResponse>
  inviteMember(
    cleanupId: string,
    actorId: string,
    input: Omit<InviteEventTeamMemberRequest, "id">,
  ): Promise<{ ok: true; invite: EventTeamInviteDTO }>
  revokeInvite(cleanupId: string, actorId: string, inviteId: string): Promise<{ ok: true }>
  acceptInvite(
    cleanupId: string,
    userId: string,
    token: string,
  ): Promise<AcceptEventTeamInviteResponse>
  scrubInviteEmails(limit: number): Promise<number>
  expireStaleInvites(limit: number): Promise<number>
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@")
  if (at <= 0) return "•••"
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  const head = local.slice(0, 1)
  const dot = domain.lastIndexOf(".")
  const tld = dot >= 0 ? domain.slice(dot) : ""
  const domainHead = dot > 0 ? domain.slice(0, 1) : domain.slice(0, 1)
  return `${head}•••@${domainHead}•••${tld}`
}

function toInviteDTO(record: EventTeamInviteRecord): EventTeamInviteDTO {
  return {
    id: record.id,
    role: record.role,
    status: record.status,
    invitee: record.invitee === null ? null : toAttendeePersonDTO(record.invitee, false),
    maskedEmail: record.invitedEmail === null ? null : maskEmail(record.invitedEmail),
    invitedBy: record.invitedBy === null ? null : toAttendeePersonDTO(record.invitedBy, false),
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    acceptedAt: record.acceptedAt === null ? null : record.acceptedAt.toISOString(),
  }
}

function toMemberDTO(
  record: EventTeamMemberRecord,
  opts: { canManage: boolean; actorId: string },
): EventTeamMemberDTO {
  const manageable =
    opts.canManage && record.role !== "organizer" && record.person.id !== opts.actorId
  return {
    person: toAttendeePersonDTO(record.person, false),
    role: record.role,
    joinedAt: record.joinedAt === null ? null : record.joinedAt.toISOString(),
    canRemove: manageable,
    canChangeRole: manageable,
  }
}

export function makeHostTeamService(deps: HostTeamServiceDeps): HostTeamService {
  const counters = deps.counters ?? fallbackCounters
  const now = deps.now ?? (() => new Date())
  const newId = deps.newId ?? (() => randomUUID())
  const newToken = deps.newToken ?? (() => generateToken(TEAM_INVITE_TOKEN_BYTES))

  async function notifyInvitee(
    email: string,
    cleanupId: string,
    role: string,
    token: string,
  ): Promise<void> {
    if (deps.mailer === undefined) return
    const title = (await deps.eventTitleOf?.(cleanupId)) ?? "a civfix event"
    const base = deps.webOrigin ?? "https://civfix.org"
    const link = `${base}/cleanups/${cleanupId}?teamInvite=${encodeURIComponent(token)}`
    try {
      await deps.mailer.sendTransactional(email, "generic", {
        subject: `You've been invited to help run ${title}`,
        message: `You've been invited to join ${title} as ${role}. Open ${link} to accept. The invitation expires in 14 days.`,
      })
    } catch (err) {
      deps.logger?.warn({ err, cleanupId }, "event team invite email failed (suppressed)")
    }
  }

  return {
    async listTeam(cleanupId: string, actorId: string): Promise<ListEventTeamResponse> {
      const resolution = await deps.standing(cleanupId, actorId, "view_event_private")
      const canManage = can(resolution.standing, "manage_team")
      const [members, invites] = await Promise.all([
        deps.repo.listTeam(cleanupId, TEAM_MEMBER_CAP),
        deps.repo.listInvites(cleanupId, TEAM_INVITE_LIST_CAP),
      ])
      return {
        members: members.map((m) => toMemberDTO(m, { canManage, actorId })),
        invites: invites.map(toInviteDTO),
      }
    },

    async inviteMember(
      cleanupId: string,
      actorId: string,
      input: Omit<InviteEventTeamMemberRequest, "id">,
    ): Promise<{ ok: true; invite: EventTeamInviteDTO }> {
      await deps.standing(cleanupId, actorId, "manage_team")
      const sent = await counters.incr(`host:teamInvites:${cleanupId}`, TEAM_INVITE_WINDOW_SEC)
      if (sent > TEAM_INVITES_PER_EVENT_PER_DAY) {
        throw AppError.rateLimited(
          "This event has sent too many team invitations today. Please try again tomorrow.",
        )
      }
      const pending = await deps.repo.countPendingInvites(cleanupId)
      if (pending >= MAX_TEAM_INVITES_PER_EVENT) {
        throw AppError.conflict("This event already has the maximum number of open invitations.")
      }
      const byEmail = input.identifierKind === "email"
      const resolved = byEmail ? null : await deps.repo.resolveUserByHandle(input.identifier)
      if (!byEmail && resolved === null) {
        throw AppError.notFound("No account matches that handle.")
      }
      const invitedUserId = resolved?.userId ?? null
      const typedEmail = byEmail ? input.identifier.toLowerCase() : null
      const notifyAt = typedEmail ?? resolved?.email ?? null
      const token = newToken()
      const outcome = await deps.repo.createInviteTx({
        inviteId: newId(),
        cleanupId,
        invitedUserId,
        invitedEmail: typedEmail,
        role: input.role,
        tokenHash: await sha256Hex(token),
        invitedBy: actorId,
        expiresAt: new Date(now().getTime() + TEAM_INVITE_TTL_MS),
        now: now(),
      })
      if (outcome.kind === "already_member") {
        throw AppError.conflict("That person is already on the event team.")
      }
      if (outcome.kind === "already_invited") {
        throw AppError.conflict("That person already has an open invitation.")
      }
      if (outcome.kind === "banned") {
        throw AppError.forbidden("A host removed that person from this event.")
      }
      if (outcome.kind === "closed") {
        throw AppError.conflict("This event is closed, so its team can no longer change.")
      }
      if (notifyAt !== null) {
        await notifyInvitee(notifyAt, cleanupId, input.role, token)
      }
      return { ok: true, invite: toInviteDTO(outcome.invite) }
    },

    async revokeInvite(
      cleanupId: string,
      actorId: string,
      inviteId: string,
    ): Promise<{ ok: true }> {
      await deps.standing(cleanupId, actorId, "manage_team")
      const outcome = await deps.repo.revokeInviteTx({ cleanupId, inviteId, actorId })
      if (outcome === "not_found") throw AppError.notFound("That invitation no longer exists.")
      return { ok: true }
    },

    async acceptInvite(
      cleanupId: string,
      userId: string,
      token: string,
    ): Promise<AcceptEventTeamInviteResponse> {
      const outcome = await deps.repo.acceptInviteTx({
        cleanupId,
        tokenHash: await sha256Hex(token),
        userId,
        now: now(),
      })
      if (outcome.kind === "invalid" || outcome.kind === "wrong_recipient") {
        throw AppError.notFound("That invitation is no longer valid.")
      }
      if (outcome.kind === "expired") {
        throw AppError.conflict("That invitation has expired.")
      }
      if (outcome.kind === "closed") {
        throw AppError.conflict("This event is closed, so its team can no longer change.")
      }
      if (outcome.kind === "banned") {
        throw AppError.forbidden("A host removed you from this event, so you can't rejoin it.")
      }
      return { ok: true, role: outcome.role }
    },

    scrubInviteEmails(limit: number): Promise<number> {
      return deps.repo.scrubInviteEmails(
        new Date(now().getTime() - TEAM_INVITE_EMAIL_SCRUB_DELAY_MS),
        limit,
      )
    },

    expireStaleInvites(limit: number): Promise<number> {
      return deps.repo.expireStaleInvites(now(), limit)
    },
  }
}

export function makeSqlTeamStanding(
  sql: Parameters<typeof requireCapability>[0],
): HostTeamStandingLookup {
  return (cleanupId, userId, capability) => requireCapability(sql, cleanupId, userId, capability)
}
