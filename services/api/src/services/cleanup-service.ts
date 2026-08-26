
import { randomUUID } from "node:crypto"
import { AppError, MAX_BRING_ITEMS, MAX_EVENT_SLOTS } from "@civfix/shared"
import { UNKNOWN_JURCODE } from "../db/reference-code.js"
import { assertNoSlur } from "../abuse/slur-filter.js"
import { InMemoryCounterStore, type CounterStore } from "../abuse/counter-store.js"
import type {
  CleanupAttendeesResponse,
  CleanupDTO,
  CleanupMemberRole,
  CleanupStatus,
  CreateCleanupRequest,
  EventKind,
  EventSlotDTO,
  EventSlotInput,
  LinkedReportRef,
  ListCleanupsRequest,
  RemoveMemberResponse,
  RequestEventResourcesResponse,
  SetMemberRoleResponse,
  UpdateCleanupRequest,
} from "@civfix/shared"
import type { Jobs } from "@civfix/shared/interfaces"
import type { NotificationService } from "./notification-service.js"
import { EVENT_HOURS_MEMBER_CAP } from "./volunteer-hours-service.js"
import type { OutboundMailService } from "./admin/outbound-mail-service.js"
import { buildEventPacket } from "./admin/mail-format.js"
import { PRESIGN_CONCURRENCY, mapWithLimit } from "./media-presign.js"
import {
  CLEANUPS_DEFAULT_LIMIT,
  ATTENDEES_DEFAULT_LIMIT,
  LINKED_REPORTS_LIST_PREVIEW,
  MAX_LINKED_REPORTS,
  toAttendeeDTO,
  toCleanupDTO,
  toEventSlotDTO,
  toLinkedReportRef,
} from "./cleanup-dto.js"
import type {
  CleanupRepository,
  DesiredSlot,
  LinkedReportView,
  ListCleanupsFilters,
  SlotReconcileResult,
  UpdateCleanupPatch,
} from "./cleanup-repository.types.js"
import { SCHEDULE_MAX_BACKDATE_MS, isCleanupTerminal } from "./cleanup-rules.js"
import {
  CLEANUP_GUEST_UPDATE_FANOUT_JOB,
  type GuestRsvpService,
  type GuestUpdateFanoutJob,
} from "./guest-rsvp-service.js"

export * from "./cleanup-repository.types.js"
export * from "./cleanup-rules.js"
export {
  CLEANUPS_DEFAULT_LIMIT,
  ATTENDEES_DEFAULT_LIMIT,
  THREAD_SIGNAL_MEMBER_CAP,
  MAX_LINKED_REPORTS,
  toAttendeeDTO,
  toAttendeePersonDTO,
  toOrganizerPerson,
  toCleanupDTO,
  toEventSlotDTO,
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

const EVENT_CLOSED_MESSAGE = "This event is closed."

function assertScheduledAtNotBackdated(next: string | undefined, stored: Date): void {
  if (next === undefined) return
  const nextMs = Date.parse(next)
  if (Number.isNaN(nextMs)) return
  if (nextMs >= Date.now() - SCHEDULE_MAX_BACKDATE_MS) return
  if (nextMs >= stored.getTime()) return
  throw AppError.validation({ scheduledAt: "must not be in the past" })
}

export const RESOURCE_REQUEST_PER_HOST_PER_DAY = 10
const RESOURCE_REQUEST_HOST_WINDOW_SEC = 24 * 60 * 60

export const RESOURCE_REQUEST_PER_JURISDICTION_PER_HOUR = 30
const RESOURCE_REQUEST_JURISDICTION_WINDOW_SEC = 60 * 60

export const ROLE_CHANGES_PER_TARGET_PER_WINDOW = 6
const ROLE_CHANGE_WINDOW_SEC = 60 * 60

export { MAX_BRING_ITEMS }

export { MAX_EVENT_SLOTS }

export const SLOT_FLIPS_PER_EVENT_PER_WINDOW = 20
const SLOT_FLIP_WINDOW_SEC = 60 * 60

const CANCEL_FANOUT_MEMBER_CAP = 2000

const CANCEL_FANOUT_CONCURRENCY = 8

const fallbackCounters = new InMemoryCounterStore()

export const CLEANUP_CANCEL_FANOUT_JOB = "cleanup.cancel.fanout"

export interface CleanupCancelFanoutJob {
  cleanupId: string
  reason: string | null
  actorId: string
}

export interface CleanupServiceDeps {
  repo: CleanupRepository
  presignThumb?: (thumbKey: string) => Promise<string>
  resolveJurisdictionGeoid?: (lat: number, lng: number) => Promise<string | null>
  resolveJurisdictionCode?: (geoid: string | null) => Promise<number>
  outboundMail?: OutboundMailService
  isVerified?: (userId: string) => Promise<boolean>
  notifier?: Pick<NotificationService, "createNotification">
  guestNotifier?: Pick<GuestRsvpService, "notifyEventCancelled" | "notifyEventUpdated">
  counters?: CounterStore
  jobs?: Jobs
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
  completeCleanup(id: string, note: string | null, requesterUserId: string): Promise<CleanupDTO>
  listCleanups(
    req: ListCleanupsRequest,
    viewer: CleanupViewer,
  ): Promise<{ items: CleanupDTO[]; nextCursor: string | null }>
  getCleanup(id: string, viewer: CleanupViewer): Promise<CleanupDTO>
  joinCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }>
  leaveCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }>
  listAttendees(id: string, viewer: CleanupViewer): Promise<CleanupAttendeesResponse>
  setMemberRole(
    id: string,
    actorId: string,
    targetUserId: string,
    role: "cohost" | "member",
  ): Promise<SetMemberRoleResponse>
  removeMember(id: string, actorId: string, targetUserId: string): Promise<RemoveMemberResponse>
  claimEventSlot(id: string, userId: string, slotId: string | null): Promise<CleanupDTO>
  requestResources(input: {
    cleanupId: string
    message: string
    actorId: string
  }): Promise<RequestEventResourcesResponse>
  runCancelFanout(job: CleanupCancelFanoutJob): Promise<void>
}

export function makeCleanupService(deps: CleanupServiceDeps): CleanupService {
  const newId = deps.newId ?? (() => randomUUID())
  const presignThumb = deps.presignThumb ?? ((thumbKey: string) => Promise.resolve(thumbKey))
  const counters = deps.counters ?? fallbackCounters

  function assertEventTextClean(input: {
    title?: string | undefined
    description?: string | null | undefined
    address?: string | null | undefined
    bring?: string[] | null | undefined
  }): void {
    assertNoSlur(input.title ?? null, "title")
    assertNoSlur(input.description ?? null, "description")
    assertNoSlur(input.address ?? null, "address")
    for (const item of input.bring ?? []) assertNoSlur(item, "bring")
  }

  function clampBring<T extends string[] | null | undefined>(bring: T): T {
    if (bring !== null && bring !== undefined && bring.length > MAX_BRING_ITEMS) {
      throw AppError.validation({ bring: `at most ${MAX_BRING_ITEMS} items may be listed` })
    }
    return bring
  }

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

  async function notifyCancellation(
    cleanup: { id: string; title: string },
    reason: string | null,
    actorId: string,
  ): Promise<void> {
    await notifyMembersOfCancellation(cleanup, reason, actorId)
    await notifyGuestsOfCancellation(cleanup.id, reason)
  }

  async function notifyGuestsOfCancellation(
    cleanupId: string,
    reason: string | null,
  ): Promise<void> {
    if (deps.guestNotifier === undefined) return
    try {
      await deps.guestNotifier.notifyEventCancelled(cleanupId, reason)
    } catch (err) {
      deps.logger?.warn(
        { err, cleanupId },
        "cleanup_cancelled guest fanout failed (suppressed)",
      )
    }
  }

  async function dispatchGuestUpdateFanout(cleanupId: string): Promise<void> {
    if (deps.jobs !== undefined) {
      try {
        await deps.jobs.enqueue(
          CLEANUP_GUEST_UPDATE_FANOUT_JOB,
          { cleanupId } satisfies GuestUpdateFanoutJob,
          { singletonKey: cleanupId },
        )
        return
      } catch (err) {
        deps.logger?.warn(
          { err, cleanupId },
          "cleanup.guest.update.fanout enqueue failed; ringing inline",
        )
      }
    }
    if (deps.guestNotifier === undefined) return
    try {
      await deps.guestNotifier.notifyEventUpdated({ cleanupId })
    } catch (err) {
      deps.logger?.warn({ err, cleanupId }, "cleanup guest update fanout failed (suppressed)")
    }
  }

  async function notifyMembersOfCancellation(
    cleanup: { id: string; title: string },
    reason: string | null,
    actorId: string,
  ): Promise<void> {
    const notifier = deps.notifier
    if (notifier === undefined) return
    let memberIds: string[]
    try {
      memberIds = await deps.repo.listMemberIds(cleanup.id, CANCEL_FANOUT_MEMBER_CAP)
    } catch (err) {
      deps.logger?.warn(
        { err, cleanupId: cleanup.id },
        "cleanup_cancelled roster read failed (suppressed)",
      )
      return
    }
    const recipients = memberIds.filter((userId) => userId !== actorId)
    await mapWithLimit(recipients, CANCEL_FANOUT_CONCURRENCY, async (userId) => {
      try {
        await notifier.createNotification(userId, {
          type: "cleanup_cancelled",
          titleKey: "notification.cleanup_cancelled.title",
          bodyKey:
            reason !== null
              ? "notification.cleanup_cancelled.body_reason"
              : "notification.cleanup_cancelled.body",
          ...(reason !== null ? { vars: { reason } } : {}),
          link: `/cleanups/${cleanup.id}`,
        })
      } catch (err) {
        deps.logger?.warn(
          { err, cleanupId: cleanup.id, userId },
          "cleanup_cancelled notification failed (suppressed)",
        )
      }
    })
  }

  async function dispatchCancelFanout(
    cleanup: { id: string; title: string },
    reason: string | null,
    actorId: string,
  ): Promise<void> {
    if (deps.jobs !== undefined) {
      try {
        await deps.jobs.enqueue(
          CLEANUP_CANCEL_FANOUT_JOB,
          { cleanupId: cleanup.id, reason, actorId } satisfies CleanupCancelFanoutJob,
          { singletonKey: cleanup.id },
        )
        return
      } catch (err) {
        deps.logger?.warn(
          { err, cleanupId: cleanup.id },
          "cleanup.cancel.fanout enqueue failed; ringing inline",
        )
      }
    }
    await notifyCancellation(cleanup, reason, actorId)
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
    const grouped = await deps.repo.loadLinkedReportsForCleanups(
      cleanupIds,
      LINKED_REPORTS_LIST_PREVIEW,
    )
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

  function toDesiredSlots(
    slots: EventSlotInput[],
    status: CleanupStatus | null,
    opts: { keepIds: boolean },
  ): DesiredSlot[] {
    if (status !== null && isCleanupTerminal(status)) {
      throw AppError.validation({ slots: "slots can't be changed after an event is completed" })
    }
    if (slots.length > MAX_EVENT_SLOTS) {
      throw AppError.validation({ slots: `at most ${MAX_EVENT_SLOTS} slots may be listed` })
    }
    const seen = new Set<string>()
    for (const slot of slots) {
      const key = slot.title.trim().toLowerCase()
      if (seen.has(key)) {
        throw AppError.validation({ slots: `duplicate slot title: ${slot.title}` })
      }
      seen.add(key)
      assertNoSlur(slot.title, "slots")
      assertNoSlur(slot.description ?? null, "slots")
    }
    return slots.map((slot, index) => ({
      ...(opts.keepIds && slot.id !== undefined ? { id: slot.id } : {}),
      title: slot.title,
      description: slot.description ?? null,
      capacity: slot.capacity ?? null,
      sortOrder: slot.sortOrder ?? index,
    }))
  }

  async function hydrateSlots(cleanupId: string, viewerId: string | null): Promise<EventSlotDTO[]> {
    const views = await deps.repo.listSlots(cleanupId, viewerId)
    return views.map(toEventSlotDTO)
  }

  async function notifySlotRemoved(
    cleanup: { id: string; title: string },
    removed: SlotReconcileResult["removed"],
  ): Promise<void> {
    const notifier = deps.notifier
    if (notifier === undefined) return
    const targets: { userId: string; slot: string }[] = []
    for (const entry of removed) {
      for (const userId of entry.claimantUserIds) {
        if (targets.length >= CANCEL_FANOUT_MEMBER_CAP) break
        targets.push({ userId, slot: entry.title })
      }
    }
    await mapWithLimit(targets, CANCEL_FANOUT_CONCURRENCY, async ({ userId, slot }) => {
      try {
        await notifier.createNotification(userId, {
          type: "cleanup_slot",
          titleKey: "notification.cleanup_slot.removed.title",
          bodyKey: "notification.cleanup_slot.removed.body",
          vars: { slot, title: cleanup.title },
          link: `/cleanups/${cleanup.id}`,
        })
      } catch (err) {
        deps.logger?.warn(
          { err, cleanupId: cleanup.id, userId },
          "cleanup_slot notification failed (suppressed)",
        )
      }
    })
  }

  return {
    async createCleanup(
      input: CreateCleanupRequest,
      organizerUserId: string,
    ): Promise<CleanupDTO> {
      assertEventTextClean(input)
      clampBring(input.bring)
      const linkedReportIds = clampLinkIds(input.linkedReportIds ?? [])
      if (input.eventKind !== "cleanup" && linkedReportIds.length > 0) {
        throw AppError.validation({ linkedReportIds: "only cleanup events can link reports" })
      }
      await assertReportsLinkable(linkedReportIds)
      const slots = toDesiredSlots(input.slots ?? [], null, { keepIds: false })

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
        slots,
      })
      const [linkedReports, slotBoard] = await Promise.all([
        hydrateLinkedReports(cleanupId, record.eventKind),
        hydrateSlots(cleanupId, organizerUserId),
      ])
      return toCleanupDTO(record, true, linkedReports, "organizer", { slots: slotBoard })
    },

    async updateCleanup(
      id: string,
      patch: UpdateCleanupRequest,
      requesterUserId: string,
    ): Promise<CleanupDTO> {
      assertEventTextClean(patch)
      clampBring(patch.bring)
      const organizerId = await deps.repo.organizerOf(id)
      if (organizerId === null) notFoundCleanup()
      const requesterRole = await deps.repo.roleOf(id, requesterUserId)
      if (requesterRole !== "organizer" && requesterRole !== "cohost") {
        throw AppError.forbidden("Only the event hosts can edit this event.")
      }

      const current = await deps.repo.findCleanupById(id, null)
      if (!current) notFoundCleanup()
      if (current.status === "cancelled") {
        throw AppError.conflict("This event has been cancelled and can no longer be edited.")
      }
      if (isCleanupTerminal(current.status)) {
        const frozen =
          patch.title !== undefined ||
          patch.scheduledAt !== undefined ||
          patch.lat !== undefined ||
          patch.lng !== undefined ||
          patch.type !== undefined ||
          patch.eventKind !== undefined
        if (frozen) {
          throw AppError.conflict(
            "A completed event's date, title, location and type can no longer be changed.",
          )
        }
      }
      assertScheduledAtNotBackdated(patch.scheduledAt, current.scheduledAt)
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

      const desiredSlots =
        patch.slots !== undefined
          ? toDesiredSlots(patch.slots, current.status, { keepIds: true })
          : null

      if (desiredSlots !== null) {
        const existingSlotIds = new Set((await deps.repo.listSlots(id, null)).map((s) => s.id))
        for (const slot of desiredSlots) {
          if (slot.id !== undefined && !existingSlotIds.has(slot.id)) {
            throw AppError.validation({ slots: `unknown slot: ${slot.id}` })
          }
        }
      }

      const movedTo =
        patch.lat !== undefined && patch.lng !== undefined
          ? { lat: patch.lat, lng: patch.lng }
          : null
      const reresolvedGeoid =
        movedTo !== null && deps.resolveJurisdictionGeoid !== undefined
          ? await deps.resolveJurisdictionGeoid(movedTo.lat, movedTo.lng)
          : undefined

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
        ...(reresolvedGeoid !== undefined ? { jurisdictionGeoid: reresolvedGeoid } : {}),
      }
      const updated = await deps.repo.updateCleanup(id, scalarPatch)
      if (!updated) notFoundCleanup()

      if (desiredLinks !== null) {
        await deps.repo.reconcileLinkedReports(id, desiredLinks, requesterUserId)
      }
      const slotDiff =
        desiredSlots !== null
          ? await deps.repo.reconcileSlots(id, desiredSlots, requesterUserId)
          : null

      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()
      if (slotDiff !== null && slotDiff.removed.length > 0) {
        await notifySlotRemoved(record, slotDiff.removed)
      }
      if (!isCleanupTerminal(record.status) && guestVisibleChange(current, patch)) {
        await dispatchGuestUpdateFanout(record.id)
      }
      const [linkedReports, slotBoard] = await Promise.all([
        hydrateLinkedReports(id, record.eventKind),
        hydrateSlots(id, requesterUserId),
      ])
      return toCleanupDTO(record, true, linkedReports, requesterRole, { slots: slotBoard })
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
      assertNoSlur(cleanReason, "reason")
      const note = cleanReason ? `Event cancelled: ${cleanReason}` : "Event cancelled"
      const body = cleanReason
        ? `This event has been cancelled by the host. Reason: ${cleanReason}`
        : `This event has been cancelled by the host.`
      const outcome = await deps.repo.cancelCleanupTx(id, {
        note,
        body,
        reason: cleanReason,
        actorId: requesterUserId,
      })
      if (outcome === "not_found") notFoundCleanup()
      if (outcome === "already_completed") {
        throw AppError.conflict("A completed event can't be cancelled.")
      }

      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()
      if (outcome === "cancelled") await dispatchCancelFanout(record, cleanReason, requesterUserId)
      const [linkedReports, slotBoard] = await Promise.all([
        hydrateLinkedReports(id, record.eventKind),
        hydrateSlots(id, requesterUserId),
      ])
      return toCleanupDTO(record, true, linkedReports, "organizer", { slots: slotBoard })
    },

    async completeCleanup(
      id: string,
      note: string | null,
      requesterUserId: string,
    ): Promise<CleanupDTO> {
      const organizerId = await deps.repo.organizerOf(id)
      if (organizerId === null) notFoundCleanup()
      const requesterRole = await deps.repo.roleOf(id, requesterUserId)
      if (requesterRole !== "organizer" && requesterRole !== "cohost") {
        throw AppError.forbidden("Only the event hosts can complete this event.")
      }
      const trimmed = note?.trim()
      const cleanNote = trimmed && trimmed.length > 0 ? trimmed : null
      assertNoSlur(cleanNote, "note")
      const timelineNote =
        cleanNote !== null ? `Event marked complete: ${cleanNote}` : "Event marked complete"
      const outcome = await deps.repo.completeCleanupTx(id, {
        note: timelineNote,
        actorId: requesterUserId,
        now: new Date(),
      })
      if (outcome === "not_found") notFoundCleanup()
      if (outcome === "cancelled") {
        throw AppError.conflict("A cancelled event can't be marked complete.")
      }
      if (outcome === "too_early") {
        throw AppError.conflict(
          "This event hasn't started yet — you can mark it complete once it begins.",
        )
      }

      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()
      const [linkedReports, slotBoard] = await Promise.all([
        hydrateLinkedReports(id, record.eventKind),
        hydrateSlots(id, requesterUserId),
      ])
      return toCleanupDTO(record, true, linkedReports, requesterRole, { slots: slotBoard })
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
      const slotCounts = await deps.repo.slotCountsFor(records.map((r) => r.id))
      const items = records.map((record) =>
        toCleanupDTO(
          record,
          rolesById.has(record.id),
          linkedByCleanup.get(record.id) ?? [],
          rolesById.get(record.id) ?? null,
          { slotCount: slotCounts.get(record.id) ?? 0 },
        ),
      )
      return { items, nextCursor }
    },

    async getCleanup(id: string, viewer: CleanupViewer): Promise<CleanupDTO> {
      const record = isUuid(id)
        ? await deps.repo.findCleanupById(id, null)
        : await deps.repo.findCleanupByReferenceCode(id)
      if (!record) notFoundCleanup()
      const [role, linkedReports, slotBoard] = await Promise.all([
        viewerRole(record.id, viewer),
        hydrateLinkedReports(record.id, record.eventKind),
        hydrateSlots(record.id, viewer.userId),
      ])
      return toCleanupDTO(record, role !== null, linkedReports, role, { slots: slotBoard })
    },

    async joinCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }> {
      const outcome = await deps.repo.joinCleanupTx(id, userId)
      if (outcome === "not_found") notFoundCleanup()
      if (outcome === "banned") {
        throw AppError.forbidden("A host removed you from this event, so you can't rejoin it.")
      }
      if (outcome === "closed") throw AppError.conflict(EVENT_CLOSED_MESSAGE)
      const going = await deps.repo.goingCount(id)
      return { joined: true, going }
    },

    async leaveCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }> {
      const organizerId = await deps.repo.organizerOf(id)
      if (organizerId === null) notFoundCleanup()
      if (organizerId === userId) {
        throw AppError.conflict("The organizer cannot leave their own cleanup.")
      }
      const outcome = await deps.repo.leaveCleanup(id, userId)
      if (outcome === "not_found") notFoundCleanup()
      if (outcome === "closed") throw AppError.conflict(EVENT_CLOSED_MESSAGE)
      const going = await deps.repo.goingCount(id)
      return { joined: false, going }
    },

    async listAttendees(id: string, viewer: CleanupViewer): Promise<CleanupAttendeesResponse> {
      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()

      const role = await viewerRole(id, viewer)
      const joined = role !== null
      const scope: CleanupAttendeesResponse["scope"] = joined ? "all" : "following"

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

      if (record.organizerUserId !== actorId) {
        throw AppError.forbidden("Only the organizer can change member roles.")
      }
      if (targetUserId === record.organizerUserId) {
        throw AppError.forbidden("The organizer's role can't be changed.")
      }
      const targetRole = await deps.repo.roleOf(id, targetUserId)
      if (targetRole === null) {
        if (role === "member" && (await deps.repo.isBanned(id, targetUserId))) {
          await deps.repo.unbanMember(id, targetUserId)
          return { ok: true }
        }
        throw AppError.notFound("That person isn't attending this event.")
      }
      if (targetRole === role) return { ok: true }

      const flips = await counters.incr(
        `cleanup:role:${id}:${targetUserId}`,
        ROLE_CHANGE_WINDOW_SEC,
      )
      if (flips > ROLE_CHANGES_PER_TARGET_PER_WINDOW) {
        throw AppError.rateLimited(
          "This attendee's role has been changed too many times recently. Please try again later.",
        )
      }

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
      if (actorRole !== "organizer" && actorRole !== "cohost") {
        throw AppError.forbidden("Only the event hosts can remove attendees.")
      }
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

      const outcome = await deps.repo.removeMember(id, targetUserId, actorId)
      if (outcome.kind === "not_found") notFoundCleanup()
      if (outcome.kind === "closed") throw AppError.conflict(EVENT_CLOSED_MESSAGE)
      if (outcome.kind === "not_member") {
        throw AppError.notFound("That person isn't attending this event.")
      }

      await notifyRoleChange(targetUserId, "removed", { id: record.id, title: record.title })
      return { ok: true, going: outcome.going }
    },

    async claimEventSlot(
      id: string,
      userId: string,
      slotId: string | null,
    ): Promise<CleanupDTO> {
      const flips = await counters.incr(`cleanup:slot:${id}:${userId}`, SLOT_FLIP_WINDOW_SEC)
      if (flips > SLOT_FLIPS_PER_EVENT_PER_WINDOW) {
        throw AppError.rateLimited(
          "You've changed your slot too many times recently. Please try again later.",
        )
      }

      const outcome =
        slotId === null
          ? await deps.repo.releaseSlot(id, userId)
          : await deps.repo.claimSlot(id, userId, slotId)

      if (outcome.kind === "not_found") notFoundCleanup()
      if (outcome.kind === "slot_not_found") {
        throw AppError.notFound("That slot no longer exists.")
      }
      if (outcome.kind === "banned") {
        throw AppError.forbidden("A host removed you from this event, so you can't rejoin it.")
      }
      if (outcome.kind === "closed") throw AppError.conflict(EVENT_CLOSED_MESSAGE)
      if (outcome.kind === "full") throw AppError.conflict("That slot is already full.")

      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()
      const role = await deps.repo.roleOf(id, userId)
      const [linkedReports, slotBoard] = await Promise.all([
        hydrateLinkedReports(id, record.eventKind),
        hydrateSlots(id, userId),
      ])
      return toCleanupDTO(record, role !== null, linkedReports, role, { slots: slotBoard })
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

      assertNoSlur(input.message, "message")

      const routing = await deps.repo.resolveJurisdictionContact(record.jurisdictionGeoid)
      if (routing === null) {
        throw AppError.notRoutable(
          "This event's area has no jurisdiction contact on file, so resources can't be requested yet.",
        )
      }

      const hostSends = await counters.incr(
        `cleanup:res-req:host:${input.actorId}`,
        RESOURCE_REQUEST_HOST_WINDOW_SEC,
      )
      const jurisdictionSends = await counters.incr(
        `cleanup:res-req:jur:${record.jurisdictionGeoid ?? "unknown"}`,
        RESOURCE_REQUEST_JURISDICTION_WINDOW_SEC,
      )
      if (hostSends > RESOURCE_REQUEST_PER_HOST_PER_DAY) {
        throw AppError.rateLimited(
          "You've sent the maximum number of resource requests for today. Please try again tomorrow.",
        )
      }
      if (jurisdictionSends > RESOURCE_REQUEST_PER_JURISDICTION_PER_HOUR) {
        throw AppError.rateLimited(
          "This area has received too many resource requests in the past hour. Please try again later.",
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

    async runCancelFanout(job: CleanupCancelFanoutJob): Promise<void> {
      const record = await deps.repo.findCleanupById(job.cleanupId, null)
      if (record === null) return
      await notifyCancellation(
        { id: record.id, title: record.title },
        job.reason,
        job.actorId,
      )
    },
  }
}

function guestVisibleChange(
  current: { scheduledAt: Date; address: string | null; lat: number; lng: number },
  patch: UpdateCleanupRequest,
): boolean {
  if (patch.scheduledAt !== undefined) {
    const next = Date.parse(patch.scheduledAt)
    if (!Number.isNaN(next) && next !== current.scheduledAt.getTime()) return true
  }
  if (patch.address !== undefined && (patch.address ?? null) !== current.address) return true
  if (patch.lat !== undefined && patch.lat !== current.lat) return true
  if (patch.lng !== undefined && patch.lng !== current.lng) return true
  return false
}

function resourceRequestNote(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim()
  const preview = collapsed.length > 140 ? `${collapsed.slice(0, 140)}…` : collapsed
  return preview.length > 0 ? `Resources requested — ${preview}` : "Resources requested"
}
