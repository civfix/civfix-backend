import { randomUUID } from "node:crypto"
import {
  AppError,
  MAX_TEAM_INVITES_PER_EVENT,
  type AcceptEventTeamInviteResponse,
  type AcceptMyEventInviteResponse,
  type CleanupDTO,
  type DeclineMyEventInviteResponse,
  type EventTeamInviteDTO,
  type EventTeamMemberDTO,
  type EventTeamRole,
  type InviteEventTeamMemberRequest,
  type HostCapability,
  type ListEventTeamResponse,
  type ListMyEventInvitesResponse,
  type PendingEventTeamInviteDTO,
} from "@civfix/shared"
import { can } from "@civfix/shared/host"
import { InMemoryCounterStore, type CounterStore } from "../../abuse/counter-store.js"
import { generateToken, sha256Hex } from "../../auth/crypto.js"
import { toAttendeePersonDTO } from "../cleanup-dto.js"
import {
  NO_AFFILIATIONS,
  withAffiliation,
  type AffiliationLoader,
  type PrimaryAffiliations,
} from "../affiliation.js"
import { mapWithLimit, PRESIGN_CONCURRENCY } from "../media-presign.js"
import type { MessageKey } from "../../i18n/renderMessage.js"
import type { CreateNotificationInput } from "../notification-service.js"
import { assertMayGrantRole, isEventPubliclyVisible, requireCapability } from "./authz.js"
import type { EventMediaPresigner } from "./event-media.js"
import type { HostStandingResolution } from "./host-standing.js"
import type {
  EventTeamInviteRecord,
  EventTeamMemberRecord,
  HostTeamRepository,
  PendingInviteForUserRecord,
} from "./host-team-repository.types.js"
import { webBaseUrlOf } from "../../lib/base-url.js"

export const TEAM_INVITES_PER_EVENT_PER_DAY = 30
const TEAM_INVITE_WINDOW_SEC = 24 * 60 * 60

export const TEAM_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000

export const TEAM_INVITE_EMAIL_SCRUB_DELAY_MS = 7 * 24 * 60 * 60 * 1000

export const TEAM_MEMBER_CAP = 200

export const TEAM_INVITE_LIST_CAP = 100

export const MY_EVENT_INVITES_DEFAULT_LIMIT = 20

export const TEAM_INVITE_TOKEN_BYTES = 32

export const TEAM_INVITE_INBOX_LINK = "/"

const TEAM_ROLE_LABEL_KEYS: Record<EventTeamRole, MessageKey> = {
  cohost: "role.cohost",
  coordinator: "role.coordinator",
  staff: "role.staff",
}

const fallbackCounters = new InMemoryCounterStore()

export interface HostTeamMailer {
  sendTransactional(to: string, template: string, vars: Record<string, unknown>): Promise<void>
}

export interface HostTeamStandingLookup {
  (cleanupId: string, userId: string, capability: HostCapability): Promise<HostStandingResolution>
}

export interface HostTeamNotifier {
  createNotification(userId: string, input: CreateNotificationInput): Promise<unknown>
}

export interface HostTeamEventLoader {
  (cleanupId: string, viewerUserId: string): Promise<CleanupDTO>
}

export interface HostTeamServiceDeps {
  repo: HostTeamRepository
  standing: HostTeamStandingLookup
  loadEvent: HostTeamEventLoader
  counters?: CounterStore
  mailer?: HostTeamMailer
  notifier?: HostTeamNotifier
  presignEventMedia?: EventMediaPresigner
  affiliations?: AffiliationLoader
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
  listMyInvites(
    userId: string,
    query: { cursor?: string; limit?: number },
  ): Promise<ListMyEventInvitesResponse>
  acceptMyInvite(userId: string, inviteId: string): Promise<AcceptMyEventInviteResponse>
  declineMyInvite(userId: string, inviteId: string): Promise<DeclineMyEventInviteResponse>
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

function toInviteDTO(
  record: EventTeamInviteRecord,
  affiliations: PrimaryAffiliations = NO_AFFILIATIONS,
): EventTeamInviteDTO {
  return {
    id: record.id,
    role: record.role,
    status: record.status,
    invitee:
      record.invitee === null
        ? null
        : withAffiliation(toAttendeePersonDTO(record.invitee, false), affiliations),
    maskedEmail: record.invitedEmail === null ? null : maskEmail(record.invitedEmail),
    invitedBy:
      record.invitedBy === null
        ? null
        : withAffiliation(toAttendeePersonDTO(record.invitedBy, false), affiliations),
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    acceptedAt: record.acceptedAt === null ? null : record.acceptedAt.toISOString(),
  }
}

function toPendingInviteDTO(
  record: PendingInviteForUserRecord,
  coverThumbUrl: string | null,
  affiliations: PrimaryAffiliations = NO_AFFILIATIONS,
): PendingEventTeamInviteDTO {
  return {
    id: record.id,
    role: record.role,
    event: {
      id: record.event.id,
      title: record.event.title,
      startsAt: record.event.startsAt.toISOString(),
      endsAt: record.event.endsAt === null ? null : record.event.endsAt.toISOString(),
      status: record.event.status,
      coverThumbUrl,
      address: record.event.address,
    },
    invitedBy:
      record.invitedBy === null
        ? null
        : withAffiliation(toAttendeePersonDTO(record.invitedBy, false), affiliations),
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  }
}

function toMemberDTO(
  record: EventTeamMemberRecord,
  opts: { canManage: boolean; actorId: string; affiliations?: PrimaryAffiliations },
): EventTeamMemberDTO {
  const manageable =
    opts.canManage && record.role !== "organizer" && record.person.id !== opts.actorId
  return {
    person: withAffiliation(
      toAttendeePersonDTO(record.person, false),
      opts.affiliations ?? NO_AFFILIATIONS,
    ),
    role: record.role,
    joinedAt: record.joinedAt === null ? null : record.joinedAt.toISOString(),
    canRemove: manageable,
    canChangeRole: manageable,
  }
}

export function teamInviteEmailVars(args: {
  title: string
  role: string
  link: string
}): Record<string, unknown> {
  return {
    subject: `You've been invited to help run ${args.title}`,
    paragraphs: [
      `You've been invited to join ${args.title} as ${args.role}.`,
      "Sign in with this email address to accept.",
    ],
    ctaUrl: args.link,
    ctaLabel: "View the invitation",
    note: "The invitation expires in 14 days. If you weren't expecting it, you can ignore this email.",
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
    title: string,
    role: string,
    token: string,
  ): Promise<void> {
    if (deps.mailer === undefined) return
    const base = deps.webOrigin ?? webBaseUrlOf({})
    const link = `${base}/cleanups/${cleanupId}#teamInvite=${encodeURIComponent(token)}`
    try {
      await deps.mailer.sendTransactional(
        email,
        "action",
        teamInviteEmailVars({ title, role, link }),
      )
    } catch (err) {
      deps.logger?.warn({ err, cleanupId }, "event team invite email failed (suppressed)")
    }
  }

  async function notifyInvitedUser(
    userId: string,
    cleanupId: string,
    title: string,
    role: EventTeamRole,
  ): Promise<void> {
    if (deps.notifier === undefined) return
    try {
      await deps.notifier.createNotification(userId, {
        type: "event_team_invite",
        titleKey: "notification.event_team_invite.title",
        bodyKey: "notification.event_team_invite.body",
        vars: { title },
        varKeys: { role: TEAM_ROLE_LABEL_KEYS[role] },
        link: TEAM_INVITE_INBOX_LINK,
        push: "auto",
      })
    } catch (err) {
      deps.logger?.warn({ err, cleanupId }, "event team invite notification failed (suppressed)")
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
      const affiliations = deps.affiliations
        ? await deps.affiliations(
            [
              ...members.map((m) => m.person.id),
              ...invites.flatMap((i) =>
                [i.invitee?.id, i.invitedBy?.id].filter((id): id is string => id !== undefined),
              ),
            ],
            actorId,
          )
        : NO_AFFILIATIONS
      return {
        members: members.map((m) => toMemberDTO(m, { canManage, actorId, affiliations })),
        invites: invites.map((i) => toInviteDTO(i, affiliations)),
      }
    },

    async inviteMember(
      cleanupId: string,
      actorId: string,
      input: Omit<InviteEventTeamMemberRequest, "id">,
    ): Promise<{ ok: true; invite: EventTeamInviteDTO }> {
      const resolution = await deps.standing(cleanupId, actorId, "manage_team")
      assertMayGrantRole(resolution.standing, input.role)
      const byEmail = input.identifierKind === "email"
      const resolved = byEmail ? null : await deps.repo.resolveUserByHandle(input.identifier)
      if (!byEmail && resolved === null) {
        throw AppError.notFound("No account matches that handle.")
      }
      const invitedUserId = resolved?.userId ?? null
      if (invitedUserId === actorId) {
        throw AppError.conflict("You can't invite yourself to an event team.")
      }
      const typedEmail = byEmail ? input.identifier.toLowerCase() : null
      const notifyAt = typedEmail ?? resolved?.email ?? null
      const alreadyOpen = await deps.repo.findOpenInvite({
        cleanupId,
        invitedUserId,
        invitedEmail: typedEmail,
      })
      if (alreadyOpen === null) {
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
      }
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
      if (outcome.kind === "banned") {
        throw AppError.forbidden("A host removed that person from this event.")
      }
      if (outcome.kind === "closed") {
        throw AppError.conflict("This event is closed, so its team can no longer change.")
      }
      if (outcome.kind === "already_invited" || outcome.kind === "updated") {
        return { ok: true, invite: toInviteDTO(outcome.invite) }
      }
      const eventTitle = (await deps.eventTitleOf?.(cleanupId)) ?? "a civfix event"
      if (notifyAt !== null) {
        await notifyInvitee(notifyAt, cleanupId, eventTitle, input.role, token)
      }
      if (invitedUserId !== null) {
        await notifyInvitedUser(invitedUserId, cleanupId, eventTitle, input.role)
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

    async listMyInvites(
      userId: string,
      query: { cursor?: string; limit?: number },
    ): Promise<ListMyEventInvitesResponse> {
      const limit = query.limit ?? MY_EVENT_INVITES_DEFAULT_LIMIT
      const { items, nextCursor } = await deps.repo.listInvitesForUser({
        userId,
        now: now(),
        cursor: query.cursor ?? null,
        limit,
      })
      const presign = deps.presignEventMedia
      const coverUrls = await mapWithLimit(items, PRESIGN_CONCURRENCY, (record) =>
        record.event.coverKey === null || presign === undefined
          ? Promise.resolve(null)
          : presign(record.event.coverKey, {
              forceSigned: !isEventPubliclyVisible(record.event.visibility),
            }),
      )
      const affiliations = deps.affiliations
        ? await deps.affiliations(
            items.map((i) => i.invitedBy?.id).filter((id): id is string => id !== undefined),
            userId,
          )
        : NO_AFFILIATIONS
      return {
        items: items.map((record, index) =>
          toPendingInviteDTO(record, coverUrls[index] ?? null, affiliations),
        ),
        nextCursor,
      }
    },

    async acceptMyInvite(userId: string, inviteId: string): Promise<AcceptMyEventInviteResponse> {
      const outcome = await deps.repo.acceptInviteByIdTx({ inviteId, userId, now: now() })
      if (outcome.kind === "not_found") {
        throw AppError.notFound("That invitation is no longer valid.")
      }
      if (outcome.kind === "not_open") {
        throw AppError.conflict("That invitation is no longer open.")
      }
      if (outcome.kind === "expired") throw AppError.conflict("That invitation has expired.")
      if (outcome.kind === "closed") {
        throw AppError.conflict("This event is closed, so its team can no longer change.")
      }
      if (outcome.kind === "banned") {
        throw AppError.forbidden("A host removed you from this event, so you can't rejoin it.")
      }
      const event = await deps.loadEvent(outcome.cleanupId, userId)
      return { ok: true, role: outcome.role, event }
    },

    async declineMyInvite(userId: string, inviteId: string): Promise<DeclineMyEventInviteResponse> {
      const outcome = await deps.repo.declineInviteTx({ inviteId, userId, now: now() })
      if (outcome === "not_found") throw AppError.notFound("That invitation is no longer valid.")
      if (outcome === "not_pending") {
        throw AppError.conflict("That invitation is no longer open.")
      }
      return { ok: true }
    },
  }
}

export function makeSqlTeamStanding(
  sql: Parameters<typeof requireCapability>[0],
): HostTeamStandingLookup {
  return (cleanupId, userId, capability) => requireCapability(sql, cleanupId, userId, capability)
}
