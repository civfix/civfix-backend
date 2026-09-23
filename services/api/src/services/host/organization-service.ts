import { randomUUID } from "node:crypto"
import {
  AppError,
  MAX_ORG_INVITES_PER_ORG,
  MAX_ORG_VERIFICATION_DOCUMENTS,
  type AcceptOrganizationInviteResponse,
  type AdminActorRef,
  type AdminCreateOrgRequest,
  type AdminOrgCounts,
  type AdminOrgDTO,
  type AdminOrgMemberDTO,
  type AdminOrgVerificationListItemDTO,
  type AdminUpdateOrgRequest,
  type ApplyOrganizationVerificationRequest,
  type CreateOrganizationRequest,
  type InviteOrganizationMemberRequest,
  type NotificationType,
  type OrganizationDTO,
  type OrganizationInviteDTO,
  type PendingOrganizationInviteDTO,
  type OrganizationMemberDTO,
  type OrganizationMemberRole,
  type OrganizationVerificationDTO,
  type OrgVerificationKind,
  type OrgVerificationStatus,
  type UpdateOrganizationRequest,
} from "@civfix/shared"
import { can } from "@civfix/shared/host"
import { assertNoSlur } from "../../abuse/slur-filter.js"
import { InMemoryCounterStore, type CounterStore } from "../../abuse/counter-store.js"
import { generateToken, sha256Hex } from "../../auth/crypto.js"
import { toAttendeePersonDTO, toOrganizationRef } from "../cleanup-dto.js"
import { NO_AFFILIATIONS, withAffiliation, type AffiliationLoader } from "../affiliation.js"
import { hostForbiddenCopy } from "./authz.js"
import { assertSlugAllowed } from "./slugs.js"
import { mapWithLimit, PRESIGN_CONCURRENCY } from "../media-presign.js"
import type {
  AdminActorView,
  AdminOrganizationRecord,
  AdminOrgListQuery,
  AdminOrgVerificationRecord,
  OrganizationBaseRecord,
  OrganizationInviteRecord,
  OrganizationOwnerRecord,
  OrganizationRecord,
  OrganizationRepository,
  OrgVerificationRecord,
  UpdateOrganizationPatch,
} from "./organization-repository.types.js"

export const ORGS_CREATED_PER_DAY = 5
const ORG_CREATE_WINDOW_SEC = 24 * 60 * 60

export const ORG_INVITES_PER_HOUR = 20
const ORG_INVITE_WINDOW_SEC = 60 * 60

export const ORG_VERIFICATIONS_PER_DAY = 3
const ORG_VERIFICATION_WINDOW_SEC = 24 * 60 * 60

export const MY_ORGANIZATIONS_CAP = 50

export const ORG_MEMBERS_DEFAULT_LIMIT = 25

export const EIN_RETENTION_DAYS = 90

/** Org invites expire after 14 days, like event team invites. */
export const ORG_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000

export const ORG_INVITE_TOKEN_BYTES = 32

export const ORG_INVITE_LIST_CAP = 100

/** The invitee's own inbox is a short triage list, not a feed: newest 20 open invites. */
export const MY_ORG_INVITES_CAP = 20

export const ADMIN_ORGS_DEFAULT_LIMIT = 25

export const ORG_LAST_ADMIN_CODE = "ORG_LAST_ADMIN"

export function lastAdminError(): AppError {
  return AppError.validation(
    { userId: ORG_LAST_ADMIN_CODE },
    "An organization needs at least one admin.",
  )
}

const fallbackCounters = new InMemoryCounterStore()

export interface OrganizationLogoPresigner {
  (key: string): Promise<string>
}

/** Transactional email seam (the same shape host-team-service uses for invites). */
export interface OrganizationMailer {
  sendTransactional(to: string, template: string, vars: Record<string, unknown>): Promise<void>
}

/** In-app notification seam: the container's NotificationService satisfies it structurally. */
export interface OrganizationNotifier {
  createNotification(
    userId: string,
    input: { type: NotificationType; title: string; body?: string; link?: string },
  ): Promise<unknown>
}

export interface OrganizationServiceDeps {
  repo: OrganizationRepository
  counters?: CounterStore
  presignLogo?: OrganizationLogoPresigner
  now?: () => Date
  newId?: () => string
  newToken?: () => string
  affiliations?: AffiliationLoader
  mailer?: OrganizationMailer
  notifier?: OrganizationNotifier
  webOrigin?: string
  logger?: {
    error: (obj: unknown, msg?: string) => void
    warn?: (obj: unknown, msg?: string) => void
  }
}

/**
 * The slug column is citext (unique case-insensitively) but stores whatever casing it is given. The shared
 * OrgSlugSchema already trims + lowercases at the HTTP edge; this repeats it in the service so an internal
 * caller (admin tooling, seeds, tests) cannot store "Ballona-Creek" next to a lookup for "ballona-creek".
 */
export function normalizeOrgSlug(slug: string): string {
  return slug.trim().toLowerCase()
}

function verificationKindLabel(kind: OrgVerificationKind | null): string {
  switch (kind) {
    case "nonprofit":
      return "nonprofit"
    case "government":
      return "government agency"
    case "community":
      return "community organization"
    default:
      return "verified organization"
  }
}

export function orgInviteEmailVars(args: {
  inviterName: string
  orgName: string
  role: "admin" | "member"
  link: string
}): Record<string, unknown> {
  const roleLabel = args.role === "admin" ? "an admin" : "a member"
  return {
    subject: `${args.inviterName} invited you to join ${args.orgName} on civfix`,
    paragraphs: [
      `${args.inviterName} invited you to join ${args.orgName} on civfix as ${roleLabel}.`,
      "Sign in with this email address to accept.",
    ],
    ctaUrl: args.link,
    ctaLabel: "Accept the invitation",
    note: "The invitation expires in 14 days. If you weren't expecting it, you can ignore this email.",
  }
}

export function orgVerificationDecisionEmailVars(args: {
  orgName: string
  kindLabel: string
  approved: boolean
  reason: string
  orgUrl: string
  verifyUrl: string
}): Record<string, unknown> {
  if (args.approved) {
    return {
      subject: `${args.orgName} is now verified as a ${args.kindLabel} on civfix`,
      paragraphs: [
        `Good news: ${args.orgName} is now verified as a ${args.kindLabel} on civfix. Its profile now carries the verified badge.`,
      ],
      ctaUrl: args.orgUrl,
      ctaLabel: "View the profile",
    }
  }
  return {
    subject: `Your verification application for ${args.orgName} was not approved`,
    paragraphs: [
      `An operator reviewed the verification application for ${args.orgName} and did not approve it.`,
    ],
    quoteHeading: "Reason",
    quote: args.reason,
    ctaUrl: args.verifyUrl,
    ctaLabel: "Re-apply for verification",
    note: "You can address the reason and re-apply at any time from the organization's verification page.",
  }
}

export interface OrganizationService {
  createOrganization(input: CreateOrganizationRequest, actorId: string): Promise<OrganizationDTO>
  listMyOrganizations(actorId: string): Promise<OrganizationDTO[]>
  getOrganizationBySlug(slug: string, viewerId: string | null): Promise<OrganizationDTO>
  updateOrganization(
    id: string,
    patch: Omit<UpdateOrganizationRequest, "id">,
    actorId: string,
  ): Promise<OrganizationDTO>
  listMembers(
    id: string,
    actorId: string,
    page: { cursor: string | null; limit: number },
  ): Promise<{ items: OrganizationMemberDTO[]; nextCursor: string | null }>
  inviteMember(
    id: string,
    actorId: string,
    input: Omit<InviteOrganizationMemberRequest, "id">,
  ): Promise<{
    ok: true
    member: OrganizationMemberDTO | null
    invited: boolean
    invite?: OrganizationInviteDTO | null
  }>
  listInvites(id: string, actorId: string): Promise<{ items: OrganizationInviteDTO[] }>
  revokeInvite(id: string, actorId: string, inviteId: string): Promise<{ ok: true }>
  acceptInvite(userId: string, token: string): Promise<AcceptOrganizationInviteResponse>
  listMyInvites(userId: string): Promise<{ items: PendingOrganizationInviteDTO[] }>
  acceptMyInvite(userId: string, inviteId: string): Promise<AcceptOrganizationInviteResponse>
  declineMyInvite(userId: string, inviteId: string): Promise<{ ok: true }>
  setMemberRole(
    id: string,
    actorId: string,
    targetUserId: string,
    role: "admin" | "member",
  ): Promise<{ ok: true }>
  removeMember(id: string, actorId: string, targetUserId: string): Promise<{ ok: true }>
  applyVerification(
    id: string,
    actorId: string,
    input: Omit<ApplyOrganizationVerificationRequest, "id">,
  ): Promise<OrganizationVerificationDTO>
  getVerification(id: string, actorId: string): Promise<OrganizationVerificationDTO>
  adminListVerifications(query: AdminOrgListQuery): Promise<{
    items: AdminOrgVerificationListItemDTO[]
    nextCursor: string | null
    pendingCount: number
  }>
  adminGetOrganization(id: string): Promise<AdminOrgDTO>
  adminListOrganizations(query: {
    q?: string
    verified?: OrgVerificationStatus
    kind?: OrgVerificationKind
    suspended?: boolean
    cursor: string | null
    limit: number
  }): Promise<{ items: AdminOrgDTO[]; nextCursor: string | null; counts?: AdminOrgCounts }>
  adminCreateOrganization(operatorId: string, input: AdminCreateOrgRequest): Promise<AdminOrgDTO>
  adminUpdateOrganization(
    id: string,
    operatorId: string,
    input: Omit<AdminUpdateOrgRequest, "id">,
  ): Promise<AdminOrgDTO>
  adminSetSuspended(
    id: string,
    operatorId: string,
    input: { suspended: boolean; reason: string },
  ): Promise<AdminOrgDTO>
  adminListMembers(
    id: string,
    page: { cursor: string | null; limit: number },
  ): Promise<{ items: AdminOrgMemberDTO[]; nextCursor: string | null }>
  adminAddMember(
    id: string,
    operatorId: string,
    input: { userId: string; role: OrganizationMemberRole; reason: string },
  ): Promise<{ ok: true }>
  adminSetMemberRole(
    id: string,
    operatorId: string,
    input: { userId: string; role: OrganizationMemberRole; reason: string },
  ): Promise<{ ok: true }>
  adminRemoveMember(
    id: string,
    operatorId: string,
    input: { userId: string; reason: string },
  ): Promise<{ ok: true }>
  adminDecideVerification(
    id: string,
    operatorId: string,
    input: { decision: "verified" | "rejected"; kind?: OrgVerificationKind; reason?: string },
  ): Promise<AdminOrgDTO>
  scrubDecidedEins(limit: number): Promise<number>
}

function notFoundOrganization(): never {
  throw AppError.notFound("Organization not found")
}

export function toOrganizationDTO(
  record: OrganizationRecord,
  logoUrl: string | null,
): OrganizationDTO {
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    description: record.description,
    websiteUrl: record.websiteUrl,
    donationUrl: record.donationUrl,
    logoMediaId: record.logoMediaId,
    logoUrl,
    socialLinks: record.socialLinks,
    verifiedStatus: record.verifiedStatus,
    verifiedKind: record.verifiedKind,
    verifiedAt: record.verifiedAt === null ? null : record.verifiedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    memberCount: record.memberCount,
    eventCount: record.eventCount,
    volunteerHours: record.volunteerHours,
    volunteerCount: record.volunteerCount,
    myRole: record.myRole,
    suspended: record.suspendedAt !== null,
  }
}

function toInviteDTO(record: OrganizationInviteRecord): OrganizationInviteDTO {
  return {
    id: record.id,
    organizationId: record.organizationId,
    email: record.email,
    // `user` names the account only once it has ACCEPTED. While pending, the row may already carry
    // the account the address resolved to, and revealing it would tell the inviter whether an
    // address has a civfix account (the enumeration oracle DECISIONS §32 rules out).
    user:
      record.status === "accepted" && record.user !== null
        ? toAttendeePersonDTO(record.user, false)
        : null,
    role: record.role,
    status: record.status,
    invitedBy: record.invitedBy === null ? null : toAttendeePersonDTO(record.invitedBy, false),
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  }
}

/**
 * The org-scoped write gate for an operator-suspended org (DECISIONS §32): members keep reading, the
 * admin plane keeps working, but self-service settings, team changes, verification applications and
 * invite acceptance are refused until an operator lifts the flag.
 */
function assertNotSuspended(record: OrganizationBaseRecord): void {
  if (record.suspendedAt === null) return
  throw AppError.forbidden(
    record.suspendedReason === null || record.suspendedReason.length === 0
      ? "This organization has been suspended, so it can't be changed right now."
      : `This organization has been suspended (${record.suspendedReason}), so it can't be changed right now.`,
  )
}

function toVerificationDTO(record: OrgVerificationRecord | null): OrganizationVerificationDTO {
  if (record === null) return { status: "unverified", kind: null }
  return {
    status: record.status,
    kind: record.kind,
    submittedAt: record.submittedAt === null ? null : record.submittedAt.toISOString(),
    reviewedAt: record.reviewedAt === null ? null : record.reviewedAt.toISOString(),
    rejectionReason: record.rejectionReason,
  }
}

function toActorRef(actor: AdminActorView | null): AdminActorRef | null {
  if (actor === null) return null
  return {
    id: actor.id,
    name: actor.name,
    handle: actor.handle,
    joined: actor.joined.toISOString(),
  }
}

function toAdminVerificationItem(
  record: AdminOrgVerificationRecord,
): AdminOrgVerificationListItemDTO {
  return {
    organizationId: record.organizationId,
    slug: record.slug,
    name: record.name,
    status: record.status,
    kind: record.kind,
    einLast4: record.einLast4,
    documentMediaIds: record.documentMediaIds,
    note: record.note,
    submittedBy: toActorRef(record.submittedBy),
    submittedAt: record.submittedAt === null ? null : record.submittedAt.toISOString(),
    reviewedBy: toActorRef(record.reviewedBy),
    reviewedAt: record.reviewedAt === null ? null : record.reviewedAt.toISOString(),
    rejectionReason: record.rejectionReason,
  }
}

export function makeOrganizationService(deps: OrganizationServiceDeps): OrganizationService {
  const counters = deps.counters ?? fallbackCounters
  const now = deps.now ?? (() => new Date())
  const newId = deps.newId ?? (() => randomUUID())
  const newToken = deps.newToken ?? (() => generateToken(ORG_INVITE_TOKEN_BYTES))
  const webBase = () => (deps.webOrigin ?? "https://civfix.org").replace(/\/+$/, "")

  async function logoUrlOf(record: OrganizationBaseRecord): Promise<string | null> {
    if (record.logoKey === null || deps.presignLogo === undefined) return null
    return deps.presignLogo(record.logoKey)
  }

  async function dto(record: OrganizationRecord): Promise<OrganizationDTO> {
    return toOrganizationDTO(record, await logoUrlOf(record))
  }

  async function presignLogoKeys(
    keys: readonly (string | null)[],
  ): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>()
    const presign = deps.presignLogo
    if (presign === undefined) return out
    const wanted = [...new Set(keys.filter((k): k is string => k !== null))]
    const urls = await mapWithLimit(wanted, PRESIGN_CONCURRENCY, (key) => presign(key))
    wanted.forEach((key, i) => {
      const url = urls[i]
      if (url !== undefined) out.set(key, url)
    })
    return out
  }

  /**
   * The one seating path behind both invite doors: the emailed token link and the in-app inbox.
   * Identical outcomes, identical copy - only the way the row is found differs.
   */
  async function seatFromInvite(
    userId: string,
    by: { tokenHash: string } | { inviteId: string },
  ): Promise<AcceptOrganizationInviteResponse> {
    const outcome = await deps.repo.acceptInviteTx({ by, userId, now: now() })
    // Same shape as event team invites: an unknown, revoked or already-used invite and one opened by
    // the wrong account all read "no longer valid" (non-probing); only expiry is named.
    if (outcome.kind === "invalid" || outcome.kind === "wrong_recipient") {
      throw AppError.notFound("That invitation is no longer valid.")
    }
    if (outcome.kind === "expired") throw AppError.conflict("That invitation has expired.")
    if (outcome.kind === "suspended") {
      throw AppError.conflict(
        "This organization is suspended, so it can't take on new members right now.",
      )
    }
    const record = await deps.repo.findOrganizationById(outcome.organizationId, userId)
    if (record === null) notFoundOrganization()
    // `role` is the SEATED role (an existing member keeps theirs), so an owner who accepted an
    // invite to their own org reads `owner` here, matching `organization.myRole`.
    return { ok: true, organization: await dto(record), role: outcome.role }
  }

  async function requireOrgCapability(
    organizationId: string,
    actorId: string,
    capability: "manage_event" | "manage_org_link" | "manage_org_members",
  ): Promise<OrganizationRecord> {
    const record = await deps.repo.findOrganizationById(organizationId, actorId)
    if (record === null) notFoundOrganization()
    if (record.myRole === null) notFoundOrganization()
    if (!can({ eventRole: null, orgRole: record.myRole }, capability)) {
      throw AppError.forbidden(hostForbiddenCopy(capability))
    }
    return record
  }

  async function requireOrgMembership(
    organizationId: string,
    actorId: string,
  ): Promise<OrganizationRecord> {
    const record = await deps.repo.findOrganizationById(organizationId, actorId)
    if (record === null || record.myRole === null) notFoundOrganization()
    return record
  }

  async function requireOrgOwner(
    organizationId: string,
    actorId: string,
  ): Promise<OrganizationRecord> {
    const record = await requireOrgMembership(organizationId, actorId)
    if (record.myRole !== "owner") {
      throw AppError.forbidden("Only the organization owner can change member roles.")
    }
    return record
  }

  function assertOrgTextClean(input: {
    name?: string | undefined
    description?: string | null | undefined
  }): void {
    assertNoSlur(input.name ?? null, "name")
    assertNoSlur(input.description ?? null, "description")
  }

  async function toAdminOrgDTO(
    record: AdminOrganizationRecord,
    verification: AdminOrgVerificationRecord | null,
  ): Promise<AdminOrgDTO> {
    return {
      id: record.id,
      slug: record.slug,
      name: record.name,
      description: record.description,
      websiteUrl: record.websiteUrl,
      donationUrl: record.donationUrl,
      logoUrl: await logoUrlOf(record),
      verifiedStatus: record.verifiedStatus,
      verifiedKind: record.verifiedKind,
      verifiedAt: record.verifiedAt === null ? null : record.verifiedAt.toISOString(),
      createdAt: record.createdAt.toISOString(),
      deletedAt: record.deletedAt === null ? null : record.deletedAt.toISOString(),
      memberCount: record.memberCount,
      eventCount: record.eventCount,
      owner: toActorRef(record.owner),
      verification: verification === null ? null : toAdminVerificationItem(verification),
      suspendedAt: record.suspendedAt === null ? null : record.suspendedAt.toISOString(),
      suspendedReason: record.suspendedReason,
      updatedAt: record.updatedAt.toISOString(),
      socialLinks: record.socialLinks,
      logoMediaId: record.logoMediaId,
    }
  }

  async function adminOrgDTO(organizationId: string): Promise<AdminOrgDTO> {
    const record = await deps.repo.adminFindOrganization(organizationId)
    if (record === null) notFoundOrganization()
    const verification = await deps.repo.adminGetVerification(organizationId)
    return toAdminOrgDTO(record, verification)
  }

  async function requireAdminOrg(organizationId: string): Promise<AdminOrganizationRecord> {
    const record = await deps.repo.adminFindOrganization(organizationId)
    if (record === null) notFoundOrganization()
    return record
  }

  /** Best-effort in-app note to someone who was just seated on an org's team (by handle, by invite, by an operator). */
  async function notifyAddedMember(
    userId: string,
    org: { name: string; slug: string },
    role: OrganizationMemberRole,
  ): Promise<void> {
    if (deps.notifier === undefined) return
    try {
      await deps.notifier.createNotification(userId, {
        type: "org_invite",
        title:
          role === "owner"
            ? `You're now the owner of ${org.name}`
            : `You've been added to ${org.name}`,
        body:
          role === "owner"
            ? "You can manage its profile, team and events on civfix."
            : `You're ${role === "admin" ? "an admin" : "a member"} of the organization on civfix.`,
        link: `/orgs/${org.slug}`,
      })
    } catch (err) {
      deps.logger?.warn?.(
        { err, userId, organization: org.slug },
        "org member added notification failed (suppressed)",
      )
    }
  }

  /**
   * BEST-EFFORT, like every other org mail: the invite row is already committed, so neither the inviter
   * lookup nor the send may fail the request. The token rides the URL FRAGMENT (`#token=`), which
   * browsers never send to the server, so it stays out of access logs, referrers and link-preview
   * fetchers; the web app reads it client-side and POSTs it in the accept body (DECISIONS §32).
   */
  async function sendInviteEmail(
    email: string,
    org: { id: string; name: string },
    inviterId: string,
    role: "admin" | "member",
    token: string,
  ): Promise<void> {
    if (deps.mailer === undefined) return
    const link = `${webBase()}/manage/org-invites/accept#token=${encodeURIComponent(token)}`
    let inviterName = `A member of ${org.name}`
    try {
      const inviter = await deps.repo.findMember(org.id, inviterId)
      if (inviter !== null) inviterName = inviter.person.displayName
    } catch (err) {
      deps.logger?.warn?.(
        { err, organization: org.name },
        "org invite: inviter lookup failed (generic name used)",
      )
    }
    try {
      await deps.mailer.sendTransactional(
        email,
        "action",
        orgInviteEmailVars({ inviterName, orgName: org.name, role, link }),
      )
    } catch (err) {
      deps.logger?.warn?.({ err, organization: org.name }, "org invite email failed (suppressed)")
    }
  }

  /** Best-effort in-app nudge to an account that was invited by its (verified) email address. */
  async function notifyInvitedUser(
    userId: string,
    org: { name: string },
    role: "admin" | "member",
  ): Promise<void> {
    if (deps.notifier === undefined) return
    try {
      await deps.notifier.createNotification(userId, {
        type: "org_invite",
        title: `You've been invited to join ${org.name}`,
        body: `Open your event dashboard to accept or decline joining as ${role === "admin" ? "an admin" : "a member"}. It expires in 14 days.`,
        link: "/dashboard",
      })
    } catch (err) {
      deps.logger?.warn?.(
        { err, userId, organization: org.name },
        "org invite notification failed (suppressed)",
      )
    }
  }

  /**
   * Tell the org OWNER how their verification application was decided: a transactional email (when the
   * owner has an address) plus an in-app `system` notification. BEST-EFFORT: the decision is already
   * committed and audited, so a mail/notification failure is logged, never raised.
   */
  async function notifyOwnerOfDecision(
    org: AdminOrgDTO,
    decision: "verified" | "rejected",
    reason: string,
  ): Promise<void> {
    if (deps.mailer === undefined && deps.notifier === undefined) return
    let owner: OrganizationOwnerRecord | null = null
    try {
      owner = await deps.repo.findOwner(org.id)
    } catch (err) {
      deps.logger?.warn?.(
        { err, organizationId: org.id },
        "org verification decision: owner lookup failed (notification suppressed)",
      )
      return
    }
    if (owner === null) return
    const base = (deps.webOrigin ?? "https://civfix.org").replace(/\/+$/, "")
    const orgPath = `/orgs/${org.slug}`
    const verifyPath = `/manage/orgs/${org.id}/verification`
    const kindLabel = verificationKindLabel(org.verifiedKind ?? null)
    const approved = decision === "verified"
    if (deps.mailer !== undefined && owner.email !== null) {
      try {
        await deps.mailer.sendTransactional(
          owner.email,
          "action",
          orgVerificationDecisionEmailVars({
            orgName: org.name,
            kindLabel,
            approved,
            reason,
            orgUrl: `${base}${orgPath}`,
            verifyUrl: `${base}${verifyPath}`,
          }),
        )
      } catch (err) {
        deps.logger?.warn?.(
          { err, organizationId: org.id, decision },
          "org verification decision email failed (suppressed)",
        )
      }
    }
    if (deps.notifier !== undefined) {
      try {
        await deps.notifier.createNotification(owner.userId, {
          type: "system",
          title: approved
            ? `${org.name} is now verified`
            : `${org.name}'s verification wasn't approved`,
          body: approved
            ? `Verified as a ${kindLabel}.`
            : `Reason: ${reason}. You can re-apply from the organization's verification page.`,
          link: approved ? orgPath : verifyPath,
        })
      } catch (err) {
        deps.logger?.warn?.(
          { err, organizationId: org.id, decision },
          "org verification decision notification failed (suppressed)",
        )
      }
    }
  }

  return {
    async createOrganization(
      input: CreateOrganizationRequest,
      actorId: string,
    ): Promise<OrganizationDTO> {
      assertOrgTextClean(input)
      const slug = normalizeOrgSlug(input.slug)
      assertSlugAllowed(slug, "slug")
      const created = await counters.incr(`org:create:${actorId}`, ORG_CREATE_WINDOW_SEC)
      if (created > ORGS_CREATED_PER_DAY) {
        throw AppError.rateLimited(
          "You've created the maximum number of organizations for today. Please try again tomorrow.",
        )
      }
      const outcome = await deps.repo.createOrganizationTx({
        organizationId: newId(),
        slug,
        name: input.name,
        description: input.description ?? null,
        websiteUrl: input.websiteUrl ?? null,
        logoMediaId: input.logoMediaId ?? null,
        socialLinks: input.socialLinks ?? null,
        createdBy: actorId,
        now: now(),
      })
      if (outcome === "slug_taken") {
        throw AppError.conflict("That organization address is already taken.")
      }
      return dto(outcome)
    },

    async listMyOrganizations(actorId: string): Promise<OrganizationDTO[]> {
      const records = await deps.repo.listMyOrganizations(actorId, MY_ORGANIZATIONS_CAP)
      return mapWithLimit(records, PRESIGN_CONCURRENCY, (record) => dto(record))
    },

    async getOrganizationBySlug(slug: string, viewerId: string | null): Promise<OrganizationDTO> {
      const record = await deps.repo.findOrganizationBySlug(normalizeOrgSlug(slug), viewerId)
      if (record === null) notFoundOrganization()
      // A suspended org's public page is gone for everyone but its own members, who still see it
      // (with suspended: true) so they can read the notice and reach the operator.
      if (record.suspendedAt !== null && record.myRole === null) notFoundOrganization()
      return dto(record)
    },

    async updateOrganization(
      id: string,
      patch: Omit<UpdateOrganizationRequest, "id">,
      actorId: string,
    ): Promise<OrganizationDTO> {
      assertOrgTextClean(patch)
      const current = await requireOrgCapability(id, actorId, "manage_event")
      assertNotSuspended(current)
      const updated = await deps.repo.updateOrganizationTx(
        id,
        {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.websiteUrl !== undefined ? { websiteUrl: patch.websiteUrl } : {}),
          ...(patch.donationUrl !== undefined ? { donationUrl: patch.donationUrl } : {}),
          ...(patch.logoMediaId !== undefined ? { logoMediaId: patch.logoMediaId } : {}),
          ...(patch.socialLinks !== undefined ? { socialLinks: patch.socialLinks } : {}),
        },
        now(),
      )
      if (updated === "not_found") notFoundOrganization()
      if (updated === "slug_taken")
        throw AppError.conflict("That organization address is already taken.")
      const record = await deps.repo.findOrganizationById(id, actorId)
      if (record === null) notFoundOrganization()
      return dto(record)
    },

    async listMembers(
      id: string,
      actorId: string,
      page: { cursor: string | null; limit: number },
    ): Promise<{ items: OrganizationMemberDTO[]; nextCursor: string | null }> {
      const record = await requireOrgMembership(id, actorId)
      const { items, nextCursor } = await deps.repo.listMembers({
        organizationId: id,
        cursor: page.cursor,
        limit: page.limit,
      })
      const canManage = can({ eventRole: null, orgRole: record.myRole }, "manage_org_members")
      const affiliations = deps.affiliations
        ? await deps.affiliations(
            items.map((m) => m.person.id),
            actorId,
          )
        : NO_AFFILIATIONS
      return {
        items: items.map((member) => ({
          person: withAffiliation(toAttendeePersonDTO(member.person, false), affiliations),
          role: member.role,
          joinedAt: member.joinedAt.toISOString(),
          canRemove: canManage && member.role !== "owner" && member.person.id !== actorId,
        })),
        nextCursor,
      }
    },

    async inviteMember(
      id: string,
      actorId: string,
      input: Omit<InviteOrganizationMemberRequest, "id">,
    ): Promise<{
      ok: true
      member: OrganizationMemberDTO | null
      invited: boolean
      invite?: OrganizationInviteDTO | null
    }> {
      const org = await requireOrgCapability(id, actorId, "manage_org_members")
      assertNotSuspended(org)
      const invites = await counters.incr(`org:invites:${id}`, ORG_INVITE_WINDOW_SEC)
      if (invites > ORG_INVITES_PER_HOUR) {
        throw AppError.rateLimited(
          "This organization has sent too many invitations recently. Please try again later.",
        )
      }
      const userId = await deps.repo.resolveUserByIdentifier({
        identifierKind: input.identifierKind,
        identifier: input.identifier,
      })
      // Every EMAIL invite is a pending record (0.41.0, DECISIONS §32), whether or not the address
      // has an account: a hashed single-use token, a 14-day expiry, an email carrying the accept
      // link, and the same `{ member: null, invited: true, invite }` answer with `invite.user` null
      // until accepted. The per-org cap is the only refusal, and it is address-independent, so the
      // inviter learns nothing about who is behind an address - not from the shape, not from a 409,
      // and not from a second call (an open invite is returned again, not rejected). An address
      // that already belongs to a member gets the same pending row; accepting closes it as a no-op.
      if (input.identifierKind === "email") {
        const email = input.identifier.toLowerCase()
        const pending = await deps.repo.countPendingInvites(id, now())
        if (pending >= MAX_ORG_INVITES_PER_ORG) {
          throw AppError.conflict(
            "This organization already has the maximum number of open invitations.",
          )
        }
        const token = newToken()
        const at = now()
        const outcome = await deps.repo.createInviteTx({
          inviteId: newId(),
          organizationId: id,
          email,
          userId,
          role: input.role,
          tokenHash: await sha256Hex(token),
          invitedBy: actorId,
          expiresAt: new Date(at.getTime() + ORG_INVITE_TTL_MS),
          now: at,
        })
        if (outcome.kind === "created") {
          await sendInviteEmail(outcome.invite.email ?? email, org, actorId, input.role, token)
          if (userId !== null) await notifyInvitedUser(userId, org, input.role)
        }
        return { ok: true, member: null, invited: true, invite: toInviteDTO(outcome.invite) }
      }
      // A HANDLE is a public identifier, so a handle invite seats the account directly and returns
      // the member row the contract allows (OrganizationMemberDTO | null); an unknown handle stays a
      // quiet no-op.
      if (userId === null) {
        return { ok: true, member: null, invited: true, invite: null }
      }
      const outcome = await deps.repo.addMemberTx({
        organizationId: id,
        userId,
        role: input.role,
        actorId,
        now: now(),
      })
      if (outcome === "added") await notifyAddedMember(userId, org, input.role)
      const member = await deps.repo.findMember(id, userId)
      return {
        ok: true,
        member:
          member === null
            ? null
            : {
                person: toAttendeePersonDTO(member.person, false),
                role: member.role,
                joinedAt: member.joinedAt.toISOString(),
                canRemove: member.role !== "owner" && member.person.id !== actorId,
              },
        invited: true,
      }
    },

    async listInvites(id: string, actorId: string): Promise<{ items: OrganizationInviteDTO[] }> {
      await requireOrgCapability(id, actorId, "manage_org_members")
      const records = await deps.repo.listInvites(id, now(), ORG_INVITE_LIST_CAP)
      return { items: records.map(toInviteDTO) }
    },

    async revokeInvite(id: string, actorId: string, inviteId: string): Promise<{ ok: true }> {
      await requireOrgCapability(id, actorId, "manage_org_members")
      const outcome = await deps.repo.revokeInviteTx({
        organizationId: id,
        inviteId,
        actorId,
        now: now(),
      })
      if (outcome === "not_found") throw AppError.notFound("That invitation no longer exists.")
      return { ok: true }
    },

    async listMyInvites(userId: string): Promise<{ items: PendingOrganizationInviteDTO[] }> {
      const records = await deps.repo.listPendingInvitesForUser({
        userId,
        now: now(),
        limit: MY_ORG_INVITES_CAP,
      })
      if (records.length === 0) return { items: [] }
      const inviterIds = records
        .map((r) => r.invitedBy?.id)
        .filter((id): id is string => id !== undefined)
      const affiliations = deps.affiliations
        ? await deps.affiliations(inviterIds, userId)
        : NO_AFFILIATIONS
      const logoUrls = await presignLogoKeys(records.map((r) => r.organization.logoKey))
      return {
        items: records.map((record) => ({
          id: record.id,
          organization: toOrganizationRef(
            record.organization,
            record.organization.logoKey === null
              ? null
              : (logoUrls.get(record.organization.logoKey) ?? null),
          ),
          role: record.role,
          invitedBy:
            record.invitedBy === null
              ? null
              : withAffiliation(toAttendeePersonDTO(record.invitedBy, false), affiliations),
          createdAt: record.createdAt.toISOString(),
          expiresAt: record.expiresAt.toISOString(),
        })),
      }
    },

    async acceptMyInvite(
      userId: string,
      inviteId: string,
    ): Promise<AcceptOrganizationInviteResponse> {
      return seatFromInvite(userId, { inviteId })
    },

    async declineMyInvite(userId: string, inviteId: string): Promise<{ ok: true }> {
      const outcome = await deps.repo.declineInviteTx({ inviteId, userId, now: now() })
      if (outcome === "invalid") throw AppError.notFound("That invitation is no longer valid.")
      if (outcome === "expired") throw AppError.conflict("That invitation has expired.")
      return { ok: true }
    },

    async acceptInvite(userId: string, token: string): Promise<AcceptOrganizationInviteResponse> {
      return seatFromInvite(userId, { tokenHash: await sha256Hex(token) })
    },

    async setMemberRole(
      id: string,
      actorId: string,
      targetUserId: string,
      role: "admin" | "member",
    ): Promise<{ ok: true }> {
      const org = await requireOrgOwner(id, actorId)
      assertNotSuspended(org)
      if (targetUserId === actorId) {
        throw AppError.conflict("You can't change your own role.")
      }
      const outcome = await deps.repo.setMemberRoleTx({
        organizationId: id,
        userId: targetUserId,
        role,
        actorId,
      })
      if (outcome === "not_member") {
        throw AppError.notFound("That person isn't a member of this organization.")
      }
      if (outcome === "owner") {
        throw AppError.forbidden("The owner's role can't be changed.")
      }
      if (outcome === "last_admin") throw lastAdminError()
      return { ok: true }
    },

    async removeMember(id: string, actorId: string, targetUserId: string): Promise<{ ok: true }> {
      if (targetUserId === actorId) await requireOrgMembership(id, actorId)
      else await requireOrgCapability(id, actorId, "manage_org_members")
      const outcome = await deps.repo.removeMemberTx({
        organizationId: id,
        userId: targetUserId,
        actorId,
      })
      if (outcome === "not_member") {
        throw AppError.notFound("That person isn't a member of this organization.")
      }
      if (outcome === "owner") {
        throw AppError.forbidden(
          targetUserId === actorId
            ? "Transfer ownership before leaving your own organization."
            : "The owner can't be removed from their own organization.",
        )
      }
      if (outcome === "last_admin") throw lastAdminError()
      return { ok: true }
    },

    async applyVerification(
      id: string,
      actorId: string,
      input: Omit<ApplyOrganizationVerificationRequest, "id">,
    ): Promise<OrganizationVerificationDTO> {
      const record = await requireOrgCapability(id, actorId, "manage_org_link")
      assertNotSuspended(record)
      assertNoSlur(input.note ?? null, "note")
      if (input.documents.length > MAX_ORG_VERIFICATION_DOCUMENTS) {
        throw AppError.validation({
          documents: `at most ${MAX_ORG_VERIFICATION_DOCUMENTS} documents may be attached`,
        })
      }
      if (record.verifiedStatus === "verified") {
        throw AppError.conflict("This organization is already verified.")
      }
      const applications = await counters.incr(`org:verify:${id}`, ORG_VERIFICATION_WINDOW_SEC)
      if (applications > ORG_VERIFICATIONS_PER_DAY) {
        throw AppError.rateLimited(
          "This organization has submitted too many verification applications today.",
        )
      }
      const applied = await deps.repo.applyVerificationTx({
        verificationId: newId(),
        organizationId: id,
        kind: input.kind,
        einNumber: input.einNumber ?? null,
        documentMediaIds: input.documents.map((d) => d.mediaId),
        note: input.note ?? null,
        submittedBy: actorId,
        now: now(),
      })
      return toVerificationDTO(applied)
    },

    async getVerification(id: string, actorId: string): Promise<OrganizationVerificationDTO> {
      await requireOrgMembership(id, actorId)
      return toVerificationDTO(await deps.repo.getVerification(id))
    },

    async adminListVerifications(query: AdminOrgListQuery): Promise<{
      items: AdminOrgVerificationListItemDTO[]
      nextCursor: string | null
      pendingCount: number
    }> {
      const page = await deps.repo.adminListVerifications(query)
      return {
        items: page.items.map(toAdminVerificationItem),
        nextCursor: page.nextCursor,
        pendingCount: page.pendingCount,
      }
    },

    adminGetOrganization(id: string): Promise<AdminOrgDTO> {
      return adminOrgDTO(id)
    },

    async adminListOrganizations(query: {
      q?: string
      verified?: OrgVerificationStatus
      kind?: OrgVerificationKind
      suspended?: boolean
      cursor: string | null
      limit: number
    }): Promise<{ items: AdminOrgDTO[]; nextCursor: string | null; counts?: AdminOrgCounts }> {
      const page = await deps.repo.adminListOrganizations(query)
      const verifications = await deps.repo.adminGetVerifications(page.items.map((o) => o.id))
      const items = await mapWithLimit(page.items, PRESIGN_CONCURRENCY, (record) =>
        toAdminOrgDTO(record, verifications.get(record.id) ?? null),
      )
      return {
        items,
        nextCursor: page.nextCursor,
        ...(page.counts !== null ? { counts: page.counts } : {}),
      }
    },

    async adminCreateOrganization(
      operatorId: string,
      input: AdminCreateOrgRequest,
    ): Promise<AdminOrgDTO> {
      assertOrgTextClean(input)
      const slug = normalizeOrgSlug(input.slug)
      assertSlugAllowed(slug, "slug")
      const owner = await deps.repo.findUser(input.ownerUserId)
      if (owner === null) {
        throw AppError.validation({ ownerUserId: "no such account" })
      }
      // No ORGS_CREATED_PER_DAY counter here: that cap is a self-service abuse brake keyed to the host,
      // and an operator onboarding a batch of partner orgs is exactly the case it must not throttle.
      // The operator's identity + reason land in the org.created audit entry instead.
      const outcome = await deps.repo.createOrganizationTx({
        organizationId: newId(),
        slug,
        name: input.name,
        description: input.description ?? null,
        websiteUrl: input.websiteUrl ?? null,
        logoMediaId: input.logoMediaId ?? null,
        socialLinks: input.socialLinks ?? null,
        createdBy: operatorId,
        ownerUserId: owner.id,
        verifiedKind: input.verifiedKind ?? null,
        operatorReason: input.reason,
        now: now(),
      })
      if (outcome === "slug_taken") {
        throw AppError.conflict("That organization address is already taken.")
      }
      await notifyAddedMember(owner.id, outcome, "owner")
      return adminOrgDTO(outcome.id)
    },

    async adminUpdateOrganization(
      id: string,
      operatorId: string,
      input: Omit<AdminUpdateOrgRequest, "id">,
    ): Promise<AdminOrgDTO> {
      assertOrgTextClean(input)
      const current = await requireAdminOrg(id)
      const patch: UpdateOrganizationPatch = {}
      const changed: string[] = []
      if (input.name !== undefined && input.name !== current.name) {
        patch.name = input.name
        changed.push("name")
      }
      if (input.slug !== undefined) {
        const slug = normalizeOrgSlug(input.slug)
        if (slug !== current.slug) {
          assertSlugAllowed(slug, "slug")
          patch.slug = slug
          changed.push("slug")
        }
      }
      if (input.description !== undefined && input.description !== current.description) {
        patch.description = input.description
        changed.push("description")
      }
      if (input.websiteUrl !== undefined && input.websiteUrl !== current.websiteUrl) {
        patch.websiteUrl = input.websiteUrl
        changed.push("websiteUrl")
      }
      if (input.logoMediaId !== undefined && input.logoMediaId !== current.logoMediaId) {
        patch.logoMediaId = input.logoMediaId
        changed.push("logoMediaId")
      }
      if (input.socialLinks !== undefined) {
        patch.socialLinks = input.socialLinks
        changed.push("socialLinks")
      }
      if (changed.length === 0) return adminOrgDTO(id)
      const outcome = await deps.repo.updateOrganizationTx(id, patch, now(), {
        actorId: operatorId,
        reason: input.reason,
        changed,
      })
      if (outcome === "not_found") notFoundOrganization()
      if (outcome === "slug_taken") {
        throw AppError.conflict("That organization address is already taken.")
      }
      return adminOrgDTO(id)
    },

    async adminSetSuspended(
      id: string,
      operatorId: string,
      input: { suspended: boolean; reason: string },
    ): Promise<AdminOrgDTO> {
      const outcome = await deps.repo.setSuspendedTx({
        organizationId: id,
        suspended: input.suspended,
        reason: input.reason,
        actorId: operatorId,
        now: now(),
      })
      if (outcome === "not_found") notFoundOrganization()
      return adminOrgDTO(id)
    },

    async adminListMembers(
      id: string,
      page: { cursor: string | null; limit: number },
    ): Promise<{ items: AdminOrgMemberDTO[]; nextCursor: string | null }> {
      await requireAdminOrg(id)
      const { items, nextCursor } = await deps.repo.adminListMembers({
        organizationId: id,
        cursor: page.cursor,
        limit: page.limit,
      })
      return {
        items: items.map((member) => ({
          user: {
            id: member.user.id,
            name: member.user.name,
            handle: member.user.handle,
            joined: member.user.joined.toISOString(),
          },
          role: member.role,
          joinedAt: member.joinedAt.toISOString(),
        })),
        nextCursor,
      }
    },

    async adminAddMember(
      id: string,
      operatorId: string,
      input: { userId: string; role: OrganizationMemberRole; reason: string },
    ): Promise<{ ok: true }> {
      const org = await requireAdminOrg(id)
      const outcome = await deps.repo.adminAddMemberTx({
        organizationId: id,
        userId: input.userId,
        role: input.role,
        actorId: operatorId,
        reason: input.reason,
        now: now(),
      })
      if (outcome === "not_found") notFoundOrganization()
      if (outcome === "user_not_found") {
        throw AppError.validation({ userId: "no such account" })
      }
      if (outcome === "already_member") {
        throw AppError.conflict(
          "That person is already a member of this organization. Change their role instead.",
        )
      }
      await notifyAddedMember(input.userId, org, input.role)
      return { ok: true }
    },

    async adminSetMemberRole(
      id: string,
      operatorId: string,
      input: { userId: string; role: OrganizationMemberRole; reason: string },
    ): Promise<{ ok: true }> {
      const org = await requireAdminOrg(id)
      const outcome = await deps.repo.adminSetMemberRoleTx({
        organizationId: id,
        userId: input.userId,
        role: input.role,
        actorId: operatorId,
        reason: input.reason,
        now: now(),
      })
      if (outcome === "not_member") {
        throw AppError.notFound("That person isn't a member of this organization.")
      }
      if (outcome === "sole_owner") {
        throw AppError.conflict(
          "An organization always has exactly one owner. Assign the owner role to another member to transfer ownership first.",
        )
      }
      if (input.role === "owner") await notifyAddedMember(input.userId, org, "owner")
      return { ok: true }
    },

    async adminRemoveMember(
      id: string,
      operatorId: string,
      input: { userId: string; reason: string },
    ): Promise<{ ok: true }> {
      await requireAdminOrg(id)
      const outcome = await deps.repo.removeMemberTx({
        organizationId: id,
        userId: input.userId,
        actorId: operatorId,
        reason: input.reason,
      })
      if (outcome === "not_member") {
        throw AppError.notFound("That person isn't a member of this organization.")
      }
      if (outcome === "owner") {
        throw AppError.conflict(
          "The owner can't be removed. Transfer ownership to another member first.",
        )
      }
      if (outcome === "last_admin") throw lastAdminError()
      return { ok: true }
    },

    async adminDecideVerification(
      id: string,
      operatorId: string,
      input: { decision: "verified" | "rejected"; kind?: OrgVerificationKind; reason?: string },
    ): Promise<AdminOrgDTO> {
      const reason = input.reason?.trim() ?? ""
      if (input.decision === "rejected" && reason.length === 0) {
        throw AppError.validation({ reason: "a rejection needs a reason" })
      }
      const outcome = await deps.repo.decideVerificationTx({
        organizationId: id,
        decision: input.decision,
        kind: input.kind ?? null,
        reason: reason.length > 0 ? reason : null,
        reviewedBy: operatorId,
        now: now(),
      })
      if (outcome === "not_found") notFoundOrganization()
      if (outcome === "no_application") {
        throw AppError.conflict("This organization has no open verification application.")
      }
      const dto = await adminOrgDTO(id)
      await notifyOwnerOfDecision(dto, input.decision, reason)
      return dto
    },

    scrubDecidedEins(limit: number): Promise<number> {
      const cutoff = new Date(now().getTime() - EIN_RETENTION_DAYS * 24 * 60 * 60 * 1000)
      return deps.repo.scrubDecidedEins(cutoff, limit)
    },
  }
}
