
import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import { UNKNOWN_JURCODE } from "../db/reference-code.js"
import type {
  CleanupAttendeesResponse,
  CleanupDTO,
  CleanupMemberRole,
  CreateCleanupRequest,
  EventKind,
  LinkedReportRef,
  ListCleanupsRequest,
  RemoveMemberResponse,
  RequestEventResourcesResponse,
  SetMemberRoleResponse,
  UpdateCleanupRequest,
} from "@civfix/shared"
import type { NotificationService } from "./notification-service.js"
import { EVENT_HOURS_MEMBER_CAP } from "./volunteer-hours-service.js"
import type { OutboundMailService } from "./admin/outbound-mail-service.js"
import { buildEventPacket } from "./admin/mail-format.js"
import { PRESIGN_CONCURRENCY, mapWithLimit } from "./media-presign.js"
import {
  CLEANUPS_DEFAULT_LIMIT,
  ATTENDEES_DEFAULT_LIMIT,
  MAX_LINKED_REPORTS,
  toAttendeeDTO,
  toCleanupDTO,
  toLinkedReportRef,
} from "./cleanup-dto.js"
import type {
  CleanupRepository,
  LinkedReportView,
  ListCleanupsFilters,
  UpdateCleanupPatch,
} from "./cleanup-repository.types.js"

export * from "./cleanup-repository.types.js"
export {
  CLEANUPS_DEFAULT_LIMIT,
  ATTENDEES_DEFAULT_LIMIT,
  THREAD_SIGNAL_MEMBER_CAP,
  MAX_LINKED_REPORTS,
  toAttendeeDTO,
  toAttendeePersonDTO,
  toOrganizerPerson,
  toCleanupDTO,
  toLinkedReportRef,
  toLinkedEventRef,
} from "./cleanup-dto.js"

export interface CleanupViewer {
  userId: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

const RESOURCE_REQUEST_COOLDOWN_MS = 10 * 60 * 1000

const RESOURCE_REQUEST_MAX_KEYS = 5000

const resourceRequestSeen = new Map<string, number>()

function withinResourceRequestCooldown(cleanupId: string, actorId: string): boolean {
  const key = `${cleanupId}:${actorId}`
  const t = Date.now()
  const until = resourceRequestSeen.get(key)
  if (until !== undefined && until > t) return true
  resourceRequestSeen.set(key, t + RESOURCE_REQUEST_COOLDOWN_MS)
  if (resourceRequestSeen.size > RESOURCE_REQUEST_MAX_KEYS) {
    for (const [k, exp] of resourceRequestSeen) if (exp <= t) resourceRequestSeen.delete(k)
  }
  return false
}

export interface CleanupServiceDeps {
  repo: CleanupRepository
  presignThumb?: (thumbKey: string) => Promise<string>
  resolveJurisdictionGeoid?: (lat: number, lng: number) => Promise<string | null>
  resolveJurisdictionCode?: (geoid: string | null) => Promise<number>
  outboundMail?: OutboundMailService
  isVerified?: (userId: string) => Promise<boolean>
  // WS4: the in-app+push bell pipeline for cleanup_role notifications (promoted / demoted / removed).
  // Optional seam: production wires the real NotificationService; a test may omit it (no bell) or
  // inject a recording fake. Failures are logged + suppressed so a bell can never fail the mutation.
  notifier?: Pick<NotificationService, "createNotification">
  logger?: { warn(obj: unknown, msg?: string): void }
  newId?: () => string
}

export interface CleanupService {
  createCleanup(input: CreateCleanupRequest, organizerUserId: string): Promise<CleanupDTO>
  updateCleanup(
    id: string,
    patch: UpdateCleanupRequest,
    requesterUserId: string,
  ): Promise<CleanupDTO>
  cancelCleanup(id: string, reason: string | null, requesterUserId: string): Promise<CleanupDTO>
  listCleanups(
    req: ListCleanupsRequest,
    viewer: CleanupViewer,
  ): Promise<{ items: CleanupDTO[]; nextCursor: string | null }>
  getCleanup(id: string, viewer: CleanupViewer): Promise<CleanupDTO>
  joinCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }>
  leaveCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }>
  listAttendees(id: string, viewer: CleanupViewer): Promise<CleanupAttendeesResponse>
  // WS4 (D3): promote member→cohost / demote cohost→member. ORGANIZER-ONLY; the organizer's own role
  // is immutable (self-targeting rejected); the target must be an existing member.
  setMemberRole(
    id: string,
    actorId: string,
    targetUserId: string,
    role: "cohost" | "member",
  ): Promise<SetMemberRoleResponse>
  // WS4 (D3): remove an attendee. Organizer removes cohosts+members; a cohost removes plain members
  // only; nobody removes the organizer. Row delete cascades chat access (cleanup_members gates chat).
  removeMember(id: string, actorId: string, targetUserId: string): Promise<RemoveMemberResponse>
  requestResources(input: {
    cleanupId: string
    message: string
    actorId: string
  }): Promise<RequestEventResourcesResponse>
}

export function makeCleanupService(deps: CleanupServiceDeps): CleanupService {
  const newId = deps.newId ?? (() => randomUUID())
  const presignThumb = deps.presignThumb ?? ((thumbKey: string) => Promise.resolve(thumbKey))

  function notFoundCleanup(): never {
    throw AppError.notFound("Cleanup not found")
  }

  async function viewerRole(
    cleanupId: string,
    viewer: CleanupViewer,
  ): Promise<CleanupMemberRole | null> {
    if (viewer.userId === null) return null
    return deps.repo.roleOf(cleanupId, viewer.userId)
  }

  // Emit a cleanup_role bell (in-app + push via the NotificationService pipeline). Best-effort: a
  // notification failure is logged + suppressed so the role/removal mutation itself never fails.
  async function notifyRoleChange(
    targetUserId: string,
    event: "promoted" | "demoted" | "removed",
    cleanup: { id: string; title: string },
  ): Promise<void> {
    if (deps.notifier === undefined) return
    try {
      await deps.notifier.createNotification(targetUserId, {
        type: "cleanup_role",
        titleKey: `notification.cleanup_role.${event}.title`,
        bodyKey: `notification.cleanup_role.${event}.body`,
        vars: { title: cleanup.title },
        link: `/cleanups/${cleanup.id}`,
      })
    } catch (err) {
      deps.logger?.warn(
        { err, targetUserId, cleanupId: cleanup.id, event },
        "cleanup_role notification failed (suppressed)",
      )
    }
  }

  async function hydrateLinkedReports(
    cleanupId: string,
    eventKind: EventKind,
  ): Promise<LinkedReportRef[]> {
    if (eventKind !== "cleanup") return []
    const grouped = await deps.repo.loadLinkedReportsForCleanups([cleanupId])
    const views = grouped.get(cleanupId) ?? []
    return mapWithLimit(views, PRESIGN_CONCURRENCY, async (v) => {
      const thumbUrl = v.thumbKey !== null ? await presignThumb(v.thumbKey) : null
      return toLinkedReportRef(v, thumbUrl)
    })
  }

  async function hydrateLinkedReportsForMany(
    records: { id: string; eventKind: EventKind }[],
  ): Promise<Map<string, LinkedReportRef[]>> {
    const cleanupIds = records.filter((r) => r.eventKind === "cleanup").map((r) => r.id)
    if (cleanupIds.length === 0) return new Map()
    const grouped = await deps.repo.loadLinkedReportsForCleanups(cleanupIds)
    const flat: { cleanupId: string; view: LinkedReportView }[] = []
    for (const [cleanupId, views] of grouped) {
      for (const view of views) flat.push({ cleanupId, view })
    }
    const refs = await mapWithLimit(flat, PRESIGN_CONCURRENCY, async ({ cleanupId, view }) => {
      const thumbUrl = view.thumbKey !== null ? await presignThumb(view.thumbKey) : null
      return { cleanupId, ref: toLinkedReportRef(view, thumbUrl) }
    })
    const out = new Map<string, LinkedReportRef[]>()
    for (const { cleanupId, ref } of refs) {
      const list = out.get(cleanupId)
      if (list) list.push(ref)
      else out.set(cleanupId, [ref])
    }
    return out
  }

  async function assertReportsLinkable(reportIds: string[]): Promise<void> {
    if (reportIds.length === 0) return
    const visible = await deps.repo.filterVisibleReportIds(reportIds)
    const bad = reportIds.filter((id) => !visible.has(id))
    if (bad.length > 0) {
      throw AppError.validation({ linkedReportIds: `not linkable: ${bad.join(", ")}` })
    }
  }

  function clampLinkIds(ids: string[]): string[] {
    if (ids.length > MAX_LINKED_REPORTS) {
      throw AppError.validation({
        linkedReportIds: `at most ${MAX_LINKED_REPORTS} reports may be linked`,
      })
    }
    return ids
  }

  return {
    async createCleanup(
      input: CreateCleanupRequest,
      organizerUserId: string,
    ): Promise<CleanupDTO> {
      const linkedReportIds = clampLinkIds(input.linkedReportIds ?? [])
      if (input.eventKind !== "cleanup" && linkedReportIds.length > 0) {
        throw AppError.validation({ linkedReportIds: "only cleanup events can link reports" })
      }
      await assertReportsLinkable(linkedReportIds)

      const jurisdictionGeoid =
        deps.resolveJurisdictionGeoid !== undefined
          ? await deps.resolveJurisdictionGeoid(input.lat, input.lng)
          : null
      const jurCode =
        deps.resolveJurisdictionCode !== undefined
          ? await deps.resolveJurisdictionCode(jurisdictionGeoid)
          : UNKNOWN_JURCODE

      const cleanupId = newId()
      const record = await deps.repo.createCleanupTx({
        cleanupId,
        organizerUserId,
        type: input.type,
        eventKind: input.eventKind,
        title: input.title,
        description: input.description ?? null,
        lat: input.lat,
        lng: input.lng,
        scheduledAt: new Date(input.scheduledAt),
        status: "upcoming",
        bring: input.bring ?? null,
        address: input.address ?? null,
        jurisdictionGeoid,
        jurCode,
        linkedReportIds,
      })
      const linkedReports = await hydrateLinkedReports(cleanupId, record.eventKind)
      return toCleanupDTO(record, true, linkedReports, "organizer")
    },

    async updateCleanup(
      id: string,
      patch: UpdateCleanupRequest,
      requesterUserId: string,
    ): Promise<CleanupDTO> {
      const organizerId = await deps.repo.organizerOf(id)
      if (organizerId === null) notFoundCleanup()
      // WS4 (D3): co-hosts can edit the event too — the gate is organizer OR cohost.
      const requesterRole = await deps.repo.roleOf(id, requesterUserId)
      if (requesterRole !== "organizer" && requesterRole !== "cohost") {
        throw AppError.forbidden("Only the event hosts can edit this event.")
      }

      const current = await deps.repo.findCleanupById(id, null)
      if (!current) notFoundCleanup()
      const effectiveKind = patch.eventKind ?? current.eventKind

      if (patch.linkedReportIds !== undefined && effectiveKind !== "cleanup") {
        throw AppError.validation({ linkedReportIds: "only cleanup events can link reports" })
      }
      const desiredLinks =
        patch.linkedReportIds !== undefined
          ? clampLinkIds(patch.linkedReportIds)
          : effectiveKind !== "cleanup"
            ? []
            : null

      if (desiredLinks !== null && desiredLinks.length > 0) {
        await assertReportsLinkable(desiredLinks)
      }

      const scalarPatch: UpdateCleanupPatch = {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.eventKind !== undefined ? { eventKind: patch.eventKind } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.scheduledAt !== undefined ? { scheduledAt: new Date(patch.scheduledAt) } : {}),
        ...(patch.lat !== undefined ? { lat: patch.lat } : {}),
        ...(patch.lng !== undefined ? { lng: patch.lng } : {}),
        ...(patch.address !== undefined ? { address: patch.address } : {}),
        ...(patch.bring !== undefined ? { bring: patch.bring } : {}),
      }
      const updated = await deps.repo.updateCleanup(id, scalarPatch)
      if (!updated) notFoundCleanup()

      if (desiredLinks !== null) {
        await deps.repo.reconcileLinkedReports(id, desiredLinks, requesterUserId)
      }

      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()
      const linkedReports = await hydrateLinkedReports(id, record.eventKind)
      return toCleanupDTO(record, true, linkedReports, requesterRole)
    },

    async cancelCleanup(
      id: string,
      reason: string | null,
      requesterUserId: string,
    ): Promise<CleanupDTO> {
      const organizerId = await deps.repo.organizerOf(id)
      if (organizerId === null) notFoundCleanup()
      if (organizerId !== requesterUserId) {
        throw AppError.forbidden("Only the organizer can cancel this event.")
      }
      const trimmed = reason?.trim()
      const cleanReason = trimmed && trimmed.length > 0 ? trimmed : null
      const note = cleanReason ? `Event cancelled: ${cleanReason}` : "Event cancelled"
      const body = cleanReason
        ? `This event has been cancelled by the host. Reason: ${cleanReason}`
        : `This event has been cancelled by the host.`
      const ok = await deps.repo.cancelCleanupTx(id, {
        note,
        body,
        reason: cleanReason,
        actorId: requesterUserId,
      })
      if (!ok) notFoundCleanup()

      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()
      const linkedReports = await hydrateLinkedReports(id, record.eventKind)
      // The canceller passed the organizer-only gate above, so their role is organizer by definition.
      return toCleanupDTO(record, true, linkedReports, "organizer")
    },

    async listCleanups(
      req: ListCleanupsRequest,
      viewer: CleanupViewer,
    ): Promise<{ items: CleanupDTO[]; nextCursor: string | null }> {
      if (req.when === "attending" && viewer.userId === null) {
        return { items: [], nextCursor: null }
      }
      const filters: ListCleanupsFilters = {
        when: req.when,
        bbox: req.bbox,
        near: req.near,
        cursor: req.cursor ?? null,
        limit: req.limit ?? CLEANUPS_DEFAULT_LIMIT,
        viewerId: viewer.userId,
      }
      const { records, nextCursor } = await deps.repo.listCleanups(filters)

      const rolesById =
        viewer.userId !== null
          ? await deps.repo.rolesOf(records.map((r) => r.id), viewer.userId)
          : new Map<string, CleanupMemberRole>()
      const linkedByCleanup = await hydrateLinkedReportsForMany(records)
      const items = records.map((record) =>
        toCleanupDTO(
          record,
          rolesById.has(record.id),
          linkedByCleanup.get(record.id) ?? [],
          rolesById.get(record.id) ?? null,
        ),
      )
      return { items, nextCursor }
    },

    async getCleanup(id: string, viewer: CleanupViewer): Promise<CleanupDTO> {
      const record = isUuid(id)
        ? await deps.repo.findCleanupById(id, null)
        : await deps.repo.findCleanupByReferenceCode(id)
      if (!record) notFoundCleanup()
      const [role, linkedReports] = await Promise.all([
        viewerRole(record.id, viewer),
        hydrateLinkedReports(record.id, record.eventKind),
      ])
      return toCleanupDTO(record, role !== null, linkedReports, role)
    },

    async joinCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }> {
      const exists = await deps.repo.joinCleanupTx(id, userId)
      if (!exists) notFoundCleanup()
      const going = await deps.repo.memberCount(id)
      return { joined: true, going }
    },

    async leaveCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }> {
      const organizerId = await deps.repo.organizerOf(id)
      if (organizerId === null) notFoundCleanup()
      if (organizerId === userId) {
        throw AppError.conflict("The organizer cannot leave their own cleanup.")
      }
      await deps.repo.leaveCleanup(id, userId)
      const going = await deps.repo.memberCount(id)
      return { joined: false, going }
    },

    async listAttendees(id: string, viewer: CleanupViewer): Promise<CleanupAttendeesResponse> {
      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()

      const role = await viewerRole(id, viewer)
      const joined = role !== null
      const scope: CleanupAttendeesResponse["scope"] = joined ? "all" : "following"

      // Hosts (organizer/cohost) need the FULL roster for per-attendee hours logging and member
      // management, so their limit matches the hours member cap; everyone else keeps the 50 default.
      const actsAsHost = role === "organizer" || role === "cohost"
      const views = await deps.repo.listAttendees({
        cleanupId: id,
        viewerId: viewer.userId,
        onlyFollowed: !joined,
        limit: actsAsHost ? EVENT_HOURS_MEMBER_CAP : ATTENDEES_DEFAULT_LIMIT,
      })
      const attendees = views.map((v) => toAttendeeDTO(v, v.isFollowing))
      return { attendees, going: record.going, scope }
    },

    async setMemberRole(
      id: string,
      actorId: string,
      targetUserId: string,
      role: "cohost" | "member",
    ): Promise<SetMemberRoleResponse> {
      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()

      // D3: promote/demote is ORGANIZER-ONLY (co-hosts cannot mint or remove other co-hosts).
      if (record.organizerUserId !== actorId) {
        throw AppError.forbidden("Only the organizer can change member roles.")
      }
      // The organizer's own role is immutable. Since only the organizer passes the gate above, this is
      // also the self-targeting rejection.
      if (targetUserId === record.organizerUserId) {
        throw AppError.forbidden("The organizer's role can't be changed.")
      }
      const targetRole = await deps.repo.roleOf(id, targetUserId)
      if (targetRole === null) {
        throw AppError.notFound("That person isn't attending this event.")
      }
      // Idempotent: setting the role they already have is a no-op success (and no bell).
      if (targetRole === role) return { ok: true }

      const flipped = await deps.repo.setMemberRole(id, targetUserId, role)
      if (!flipped) throw AppError.notFound("That person isn't attending this event.")

      await notifyRoleChange(
        targetUserId,
        role === "cohost" ? "promoted" : "demoted",
        { id: record.id, title: record.title },
      )
      return { ok: true }
    },

    async removeMember(
      id: string,
      actorId: string,
      targetUserId: string,
    ): Promise<RemoveMemberResponse> {
      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()

      const actorRole = await deps.repo.roleOf(id, actorId)
      // D3 matrix: organizer removes cohosts+members; a cohost removes plain members only.
      if (actorRole !== "organizer" && actorRole !== "cohost") {
        throw AppError.forbidden("Only the event hosts can remove attendees.")
      }
      // Removing yourself is what /leave is for (and the organizer can never be removed at all).
      if (targetUserId === actorId) {
        throw AppError.conflict("You can't remove yourself — leave the event instead.")
      }
      if (targetUserId === record.organizerUserId) {
        throw AppError.forbidden("The organizer can't be removed from their own event.")
      }
      const targetRole = await deps.repo.roleOf(id, targetUserId)
      if (targetRole === null) {
        throw AppError.notFound("That person isn't attending this event.")
      }
      if (targetRole === "cohost" && actorRole !== "organizer") {
        throw AppError.forbidden("Only the organizer can remove a co-host.")
      }

      // Leave semantics: deleting the cleanup_members row is the whole removal (the same row gates
      // chat access, so the target drops out of the event group chat automatically).
      const { removed, going } = await deps.repo.removeMember(id, targetUserId)
      if (!removed) throw AppError.notFound("That person isn't attending this event.")

      await notifyRoleChange(targetUserId, "removed", { id: record.id, title: record.title })
      return { ok: true, going }
    },

    async requestResources(input: {
      cleanupId: string
      message: string
      actorId: string
    }): Promise<RequestEventResourcesResponse> {
      if (deps.outboundMail === undefined || deps.isVerified === undefined) {
        throw AppError.internal("Event resource requests are not available")
      }
      const record = await deps.repo.findCleanupById(input.cleanupId, null)
      if (!record) notFoundCleanup()

      if (record.organizerUserId !== input.actorId) {
        throw AppError.forbidden("Only the event host can request resources.")
      }
      const verified = await deps.isVerified(input.actorId)
      if (!verified) {
        throw AppError.forbidden("Only identity-verified hosts can request resources.")
      }

      const routing = await deps.repo.resolveJurisdictionContact(record.jurisdictionGeoid)
      if (routing === null) {
        throw AppError.notRoutable(
          "This event's area has no jurisdiction contact on file, so resources can't be requested yet.",
        )
      }

      if (withinResourceRequestCooldown(record.id, input.actorId)) {
        throw AppError.rateLimited(
          "You've already requested resources for this event recently. Please wait before sending another.",
        )
      }

      const packet = buildEventPacket(
        {
          title: record.title,
          host: record.organizer.displayName,
          place: routing.name,
          address: record.address,
          lat: record.lat,
          lng: record.lng,
          referenceCode: record.referenceCode,
        },
        input.message,
      )
      await deps.outboundMail.sendEventToJurisdiction({
        cleanupId: record.id,
        geoid: record.jurisdictionGeoid,
        org: routing.name,
        toAddr: routing.contact,
        subject: packet.subject,
        text: packet.text,
        html: packet.html,
      })

      await deps.repo.appendCleanupTimeline(record.id, {
        kind: "resource_request",
        note: resourceRequestNote(input.message),
        actorId: input.actorId,
      })
      return { ok: true }
    },
  }
}

function resourceRequestNote(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim()
  const preview = collapsed.length > 140 ? `${collapsed.slice(0, 140)}…` : collapsed
  return preview.length > 0 ? `Resources requested — ${preview}` : "Resources requested"
}
