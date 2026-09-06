import { randomUUID } from "node:crypto"
import {
  AppError,
  MAX_ORG_VERIFICATION_DOCUMENTS,
  type AdminActorRef,
  type AdminOrgDTO,
  type AdminOrgVerificationListItemDTO,
  type ApplyOrganizationVerificationRequest,
  type CreateOrganizationRequest,
  type InviteOrganizationMemberRequest,
  type OrganizationDTO,
  type OrganizationMemberDTO,
  type OrganizationVerificationDTO,
  type OrgVerificationKind,
  type UpdateOrganizationRequest,
} from "@civfix/shared"
import { can } from "@civfix/shared/host"
import { assertNoSlur } from "../../abuse/slur-filter.js"
import { InMemoryCounterStore, type CounterStore } from "../../abuse/counter-store.js"
import { toAttendeePersonDTO } from "../cleanup-dto.js"
import { hostForbiddenCopy } from "./authz.js"
import { assertSlugAllowed } from "./slugs.js"
import { mapWithLimit, PRESIGN_CONCURRENCY } from "../media-presign.js"
import type {
  AdminActorView,
  AdminOrgListQuery,
  AdminOrgVerificationRecord,
  OrganizationRecord,
  OrganizationRepository,
  OrgVerificationRecord,
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

const fallbackCounters = new InMemoryCounterStore()

export interface OrganizationLogoPresigner {
  (key: string): Promise<string>
}

export interface NonprofitVerifiedHook {
  (event: { organizationId: string; ein: string | null; operatorId: string }): Promise<void>
}

export interface OrganizationServiceDeps {
  repo: OrganizationRepository
  counters?: CounterStore
  presignLogo?: OrganizationLogoPresigner
  now?: () => Date
  newId?: () => string
  onNonprofitVerified?: NonprofitVerifiedHook
  logger?: { error: (obj: unknown, msg?: string) => void }
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
  ): Promise<{ ok: true; member: OrganizationMemberDTO | null; invited: boolean }>
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
    logoMediaId: record.logoMediaId,
    logoUrl,
    socialLinks: record.socialLinks,
    verifiedStatus: record.verifiedStatus,
    verifiedKind: record.verifiedKind,
    verifiedAt: record.verifiedAt === null ? null : record.verifiedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    memberCount: record.memberCount,
    eventCount: record.eventCount,
    myRole: record.myRole,
  }
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

  async function logoUrlOf(record: OrganizationRecord): Promise<string | null> {
    if (record.logoKey === null || deps.presignLogo === undefined) return null
    return deps.presignLogo(record.logoKey)
  }

  async function dto(record: OrganizationRecord): Promise<OrganizationDTO> {
    return toOrganizationDTO(record, await logoUrlOf(record))
  }

  async function requireOrgCapability(
    organizationId: string,
    actorId: string,
    capability: "manage_event" | "manage_team" | "manage_org_link",
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

  function assertOrgTextClean(input: {
    name?: string | undefined
    description?: string | null | undefined
  }): void {
    assertNoSlur(input.name ?? null, "name")
    assertNoSlur(input.description ?? null, "description")
  }

  async function adminOrgDTO(organizationId: string): Promise<AdminOrgDTO> {
    const record = await deps.repo.findOrganizationById(organizationId, null)
    if (record === null) notFoundOrganization()
    const verification = await deps.repo.adminGetVerification(organizationId)
    return {
      id: record.id,
      slug: record.slug,
      name: record.name,
      description: record.description,
      websiteUrl: record.websiteUrl,
      logoUrl: await logoUrlOf(record),
      verifiedStatus: record.verifiedStatus,
      verifiedKind: record.verifiedKind,
      verifiedAt: record.verifiedAt === null ? null : record.verifiedAt.toISOString(),
      createdAt: record.createdAt.toISOString(),
      deletedAt: record.deletedAt === null ? null : record.deletedAt.toISOString(),
      memberCount: record.memberCount,
      eventCount: record.eventCount,
      owner: null,
      verification: verification === null ? null : toAdminVerificationItem(verification),
      donationsEnabled: false,
      paymentsState: null,
    }
  }

  return {
    async createOrganization(
      input: CreateOrganizationRequest,
      actorId: string,
    ): Promise<OrganizationDTO> {
      assertOrgTextClean(input)
      assertSlugAllowed(input.slug, "slug")
      const created = await counters.incr(`org:create:${actorId}`, ORG_CREATE_WINDOW_SEC)
      if (created > ORGS_CREATED_PER_DAY) {
        throw AppError.rateLimited(
          "You've created the maximum number of organizations for today. Please try again tomorrow.",
        )
      }
      const outcome = await deps.repo.createOrganizationTx({
        organizationId: newId(),
        slug: input.slug,
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
      const record = await deps.repo.findOrganizationBySlug(slug, viewerId)
      if (record === null) notFoundOrganization()
      return dto(record)
    },

    async updateOrganization(
      id: string,
      patch: Omit<UpdateOrganizationRequest, "id">,
      actorId: string,
    ): Promise<OrganizationDTO> {
      assertOrgTextClean(patch)
      await requireOrgCapability(id, actorId, "manage_event")
      const updated = await deps.repo.updateOrganizationTx(
        id,
        {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.websiteUrl !== undefined ? { websiteUrl: patch.websiteUrl } : {}),
          ...(patch.logoMediaId !== undefined ? { logoMediaId: patch.logoMediaId } : {}),
          ...(patch.socialLinks !== undefined ? { socialLinks: patch.socialLinks } : {}),
        },
        now(),
      )
      if (!updated) notFoundOrganization()
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
      const canManage = record.myRole === "owner" || record.myRole === "admin"
      return {
        items: items.map((member) => ({
          person: toAttendeePersonDTO(member.person, false),
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
    ): Promise<{ ok: true; member: OrganizationMemberDTO | null; invited: boolean }> {
      await requireOrgCapability(id, actorId, "manage_team")
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
      if (userId !== null) {
        await deps.repo.addMemberTx({
          organizationId: id,
          userId,
          role: input.role,
          actorId,
          now: now(),
        })
      }
      return { ok: true, member: null, invited: true }
    },

    async setMemberRole(
      id: string,
      actorId: string,
      targetUserId: string,
      role: "admin" | "member",
    ): Promise<{ ok: true }> {
      await requireOrgCapability(id, actorId, "manage_team")
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
      return { ok: true }
    },

    async removeMember(id: string, actorId: string, targetUserId: string): Promise<{ ok: true }> {
      if (targetUserId === actorId) await requireOrgMembership(id, actorId)
      else await requireOrgCapability(id, actorId, "manage_team")
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
      return { ok: true }
    },

    async applyVerification(
      id: string,
      actorId: string,
      input: Omit<ApplyOrganizationVerificationRequest, "id">,
    ): Promise<OrganizationVerificationDTO> {
      const record = await requireOrgCapability(id, actorId, "manage_org_link")
      assertNoSlur(input.note ?? null, "note")
      if (input.documents.length > MAX_ORG_VERIFICATION_DOCUMENTS) {
        throw AppError.validation({
          documents: `at most ${MAX_ORG_VERIFICATION_DOCUMENTS} documents may be attached`,
        })
      }
      if (record.verifiedStatus === "verified") {
        throw AppError.conflict("This organization is already verified.")
      }
      const applications = await counters.incr(
        `org:verify:${id}`,
        ORG_VERIFICATION_WINDOW_SEC,
      )
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
      if (
        input.decision === "verified" &&
        dto.verifiedKind === "nonprofit" &&
        deps.onNonprofitVerified !== undefined
      ) {
        try {
          await deps.onNonprofitVerified({
            organizationId: id,
            ein: await deps.repo.verifiedEinOf(id),
            operatorId,
          })
        } catch (error) {
          deps.logger?.error(
            { evt: "org.verification.eligibility_hook_failed", organizationId: id, err: error },
            "nonprofit verified but the eligibility follow-up failed; the EIN is recorded and an operator can evaluate on demand",
          )
        }
      }
      return dto
    },

    scrubDecidedEins(limit: number): Promise<number> {
      const cutoff = new Date(now().getTime() - EIN_RETENTION_DAYS * 24 * 60 * 60 * 1000)
      return deps.repo.scrubDecidedEins(cutoff, limit)
    },
  }
}
