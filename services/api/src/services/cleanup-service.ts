import { randomUUID } from "node:crypto"
import {
  AppError,
  ErrorCode,
  MAX_BRING_ITEMS,
  MAX_LINKED_REPORTS,
  collapseWhitespace,
} from "@civfix/shared"
import { can, hostCapabilities, NO_HOST_STANDING, type HostStanding } from "@civfix/shared/host"
import { isUuid } from "../db/cursor-helpers.js"
import { UNKNOWN_JURCODE } from "../db/reference-code.js"
import { assertNoSlur } from "../abuse/slur-filter.js"
import { InMemoryCounterStore, type CounterStore } from "../abuse/counter-store.js"
import type {
  CleanupAttendeesResponse,
  CleanupDTO,
  CleanupMemberRole,
  CreateCleanupRequest,
  DuplicateCleanupRequest,
  EventKind,
  EventSlotDTO,
  HostCapability,
  OrganizationMemberRole,
  LinkedReportRef,
  ListCleanupsRequest,
  RemoveMemberResponse,
  RequestEventResourcesResponse,
  SetMemberRoleResponse,
  UpdateCleanupRequest,
} from "@civfix/shared"
import type { Jobs } from "@civfix/shared/interfaces"
import type { AddressResolver } from "./address-resolver.js"
import type { NotificationService } from "./notification-service.js"
import { EVENT_HOURS_MEMBER_CAP } from "./volunteer-hours-service.js"
import type { OutboundMailService } from "./admin/outbound-mail-service.js"
import { buildEventPacket } from "./admin/mail-format.js"
import { mapWithLimit } from "../lib/concurrency.js"
import { SECONDS_PER_DAY, SECONDS_PER_HOUR } from "../lib/time.js"
import { PRESIGN_CONCURRENCY } from "./media-presign.js"
import { attachAffiliations, type AffiliationLoader } from "./affiliation.js"
import {
  CLEANUPS_DEFAULT_LIMIT,
  ATTENDEES_DEFAULT_LIMIT,
  LINKED_REPORTS_LIST_PREVIEW,
  toAttendeeDTO,
  toCleanupDTO,
  toEventSlotDTO,
  toLinkedReportRef,
} from "./cleanup-dto.js"
import type {
  CleanupOrganizationView,
  CleanupRecord,
  CleanupRepository,
  DesiredSlot,
  DuplicateSource,
  EventHostWrite,
  EventSlotView,
  LinkedReportView,
  ListCleanupsFilters,
  SignupSeat,
  SlotReconcileResult,
  UpdateCleanupPatch,
} from "./cleanup-repository.types.js"
import {
  assertMayGrantRole,
  hasHostStanding,
  hostForbiddenCopy,
  isEventPubliclyVisible,
} from "./host/authz.js"
import {
  assertEventWindow,
  assertGalleryWithinCap,
  assertValidReminderOffsets,
  assertValidTimezone,
} from "./host/event-fields.js"
import { assertSlugAllowed } from "./host/slugs.js"
import type { TicketTokenSigner } from "./host/ticket-token.js"
import { NULL_HOST_AUDIT_SINK, type HostAuditSink } from "./host/host-audit.js"
import type { InsightsInvalidator } from "./host/host-analytics-cache.js"
import { enqueueWaitlistPromotion } from "./host/waitlist-promotion.js"
import {
  DEFAULT_EVENT_DURATION_MS,
  EVENT_NEEDS_A_SLOT_MESSAGE,
  SCHEDULE_MAX_BACKDATE_MS,
  defaultEventSlot,
  deriveCleanupStatus,
  eventEndedError,
  eventWindowOf,
} from "./cleanup-rules.js"
import type { EventWindow } from "./cleanup-rules.js"
import { eventAddressPatch, resolveEventAddress } from "./cleanup-address.js"
import { assertKnownSlotIds, assertTimedSlotsFitWindow, toDesiredSlots } from "./cleanup-slots.js"
import { makeCleanupNotifications, type CleanupCancelFanoutJob } from "./cleanup-notifications.js"

export * from "./cleanup-repository.types.js"
export { CANCEL_FANOUT_MEMBER_CAP, CLEANUP_CANCEL_FANOUT_JOB } from "./cleanup-notifications.js"
export {
  CLEANUPS_DEFAULT_LIMIT,
  ATTENDEES_DEFAULT_LIMIT,
  THREAD_SIGNAL_MEMBER_CAP,
  toCleanupDTO,
  toLinkedReportRef,
  toLinkedEventRef,
} from "./cleanup-dto.js"

export interface CleanupViewer {
  userId: string | null
}

export type UpdateCleanupPatchRequest = Omit<UpdateCleanupRequest, "id">

type HostEventPatch = Pick<
  UpdateCleanupRequest,
  | "endsAt"
  | "timezone"
  | "visibility"
  | "coverMediaId"
  | "galleryMediaIds"
  | "donationUrl"
  | "pageSlug"
  | "registrationOpensAt"
  | "registrationClosesAt"
  | "organizationId"
  | "reminderOffsetsMinutes"
  | "hostReplyTo"
> & { scheduledAt?: string }

// `joined` means an RSVP (a cleanup_members row, which the organizer always has). Org standing
// grants host powers and visibility, not attendance: clients key Join/Leave off this flag.
function isAttending(standing: HostStanding): boolean {
  return standing.eventRole !== null
}

function toDateOrNull(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null
  return new Date(value)
}

const HOST_REFUSAL_CODES = new Set<ErrorCode>([
  ErrorCode.FORBIDDEN,
  ErrorCode.CONFLICT,
  ErrorCode.VALIDATION,
])

function isHostRefusal(err: unknown): boolean {
  return err instanceof AppError && HOST_REFUSAL_CODES.has(err.code)
}

function futureOrNull(at: Date | null, now: Date): string | null {
  return at !== null && at.getTime() > now.getTime() ? at.toISOString() : null
}

const EVENT_CLOSED_MESSAGE = "This event is closed."

const CANCELLED_EVENT_EDIT_MESSAGE = "This event has been cancelled and can no longer be edited."

const ONLY_CLEANUPS_LINK_REPORTS_MESSAGE = "only cleanup events can link reports"

const NOT_ATTENDING_MESSAGE = "That person isn't attending this event."

const REMOVED_BY_HOST_MESSAGE = "A host removed you from this event, so you can't rejoin it."

const RESOURCE_NOTE_PREVIEW_CHARS = 140

const UNKNOWN_JURISDICTION_BUDGET_KEY = "unknown"

function refusalOnceEnded(
  patch: UpdateCleanupPatchRequest,
  current: CleanupRecord,
): AppError | null {
  const frozen =
    patch.title !== undefined ||
    patch.scheduledAt !== undefined ||
    patch.lat !== undefined ||
    patch.lng !== undefined ||
    patch.type !== undefined ||
    patch.eventKind !== undefined
  if (frozen) {
    return AppError.conflict(
      "An event that has ended can't change its date, title, location or type.",
    )
  }
  if (
    patch.endsAt !== undefined &&
    patch.endsAt !== null &&
    new Date(patch.endsAt).getTime() !== current.endsAt.getTime()
  ) {
    return AppError.conflict("An event that has ended can't change its end time.")
  }
  if (patch.slots !== undefined) {
    return AppError.validation({ slots: "Slots can't be changed after an event has ended." })
  }
  return null
}

function assertScheduledAtNotBackdated(
  next: string | undefined,
  stored: Date,
  nowMs: number,
): void {
  if (next === undefined) return
  const nextMs = Date.parse(next)
  if (Number.isNaN(nextMs)) return
  if (nextMs >= nowMs - SCHEDULE_MAX_BACKDATE_MS) return
  if (nextMs >= stored.getTime()) return
  throw AppError.validation({ scheduledAt: "must not be in the past" })
}

function editedWindowOf(
  current: CleanupRecord,
  patch: UpdateCleanupPatchRequest,
): { window: EventWindow; moved: boolean } {
  if (patch.endsAt === null) {
    throw AppError.validation({ endsAt: "an event must have an end time" })
  }
  const window: EventWindow = {
    status: current.status,
    scheduledAt:
      patch.scheduledAt !== undefined ? new Date(patch.scheduledAt) : current.scheduledAt,
    endsAt: patch.endsAt !== undefined ? new Date(patch.endsAt) : current.endsAt,
  }
  const moved =
    window.scheduledAt.getTime() !== current.scheduledAt.getTime() ||
    (window.endsAt?.getTime() ?? null) !== (current.endsAt?.getTime() ?? null)
  return { window, moved }
}

function plannedEventWindow(input: CreateCleanupRequest): {
  scheduledAt: Date
  endsAt: Date
  slots: DesiredSlot[]
} {
  if (input.endsAt === null) throw AppError.validation({ endsAt: "required" })
  if (input.slots !== undefined && input.slots.length === 0) {
    throw AppError.validation({ slots: EVENT_NEEDS_A_SLOT_MESSAGE })
  }
  const scheduledAt = new Date(input.scheduledAt)
  const endsAt =
    input.endsAt !== undefined
      ? new Date(input.endsAt)
      : new Date(scheduledAt.getTime() + DEFAULT_EVENT_DURATION_MS)
  const slots = toDesiredSlots(
    input.slots ?? [defaultEventSlot(null)],
    { keepIds: false },
    { scheduledAt, endsAt },
  )
  return { scheduledAt, endsAt, slots }
}

function duplicateRequestOf(
  source: CleanupRecord,
  sourceSlots: EventSlotView[],
  input: DuplicateCleanupRequest,
  organizationId: string | null,
  now: Date,
): CreateCleanupRequest {
  const scheduledAt = new Date(input.scheduledAt)
  const sourceDurationMs = source.endsAt.getTime() - source.scheduledAt.getTime()
  const endsAt = input.endsAt ?? new Date(scheduledAt.getTime() + sourceDurationMs).toISOString()
  const shiftMs = scheduledAt.getTime() - source.scheduledAt.getTime()
  const shifted = (at: Date | null): string | null =>
    at === null ? null : new Date(at.getTime() + shiftMs).toISOString()
  return {
    title: source.title,
    type: source.type,
    eventKind: source.eventKind,
    ...(source.description !== null ? { description: source.description } : {}),
    lat: source.lat,
    lng: source.lng,
    scheduledAt: scheduledAt.toISOString(),
    ...(source.bring !== null ? { bring: source.bring } : {}),
    ...(source.address !== null
      ? {
          address: source.address,
          ...(source.addressSource !== null ? { addressSource: source.addressSource } : {}),
        }
      : {}),
    slots:
      sourceSlots.length > 0
        ? sourceSlots.map((slot) => ({
            title: slot.title,
            description: slot.description,
            capacity: slot.capacity,
            startsAt: shifted(slot.startsAt),
            endsAt: shifted(slot.endsAt),
            sortOrder: slot.sortOrder,
          }))
        : [defaultEventSlot(source.capacity)],
    endsAt,
    timezone: source.timezone,
    visibility: source.visibility,
    donationUrl: source.donationUrl,
    registrationOpensAt: futureOrNull(source.registrationOpensAt, now),
    registrationClosesAt: futureOrNull(source.registrationClosesAt, now),
    organizationId,
    reminderOffsetsMinutes: source.reminderOffsetsMin,
    hostReplyTo: source.hostReplyTo,
  }
}

export const RESOURCE_REQUEST_PER_HOST_PER_DAY = 10
const RESOURCE_REQUEST_HOST_WINDOW_SEC = SECONDS_PER_DAY

export const RESOURCE_REQUEST_PER_JURISDICTION_PER_HOUR = 30
const RESOURCE_REQUEST_JURISDICTION_WINDOW_SEC = SECONDS_PER_HOUR

export const ROLE_CHANGES_PER_TARGET_PER_WINDOW = 6
const ROLE_CHANGE_WINDOW_SEC = SECONDS_PER_HOUR

export { MAX_BRING_ITEMS }

export const SLOT_FLIPS_PER_EVENT_PER_WINDOW = 20
const SLOT_FLIP_WINDOW_SEC = SECONDS_PER_HOUR

export const MEMBERSHIP_FLIPS_PER_EVENT_PER_WINDOW = 20
const MEMBERSHIP_FLIP_WINDOW_SEC = SECONDS_PER_HOUR

const fallbackCounters = new InMemoryCounterStore()

export const HOST_EVENTS_PER_DAY = 10
export const HOST_EVENTS_WINDOW_SEC = SECONDS_PER_DAY

export const HOST_ROSTER_READS_PER_HOUR = 200
const HOST_ROSTER_READ_WINDOW_SEC = SECONDS_PER_HOUR

const ROSTER_AUDIT_DEDUPE_WINDOW_SEC = SECONDS_PER_HOUR

const CLEANUP_CREATE_IDEMPOTENCY_SCOPE = "cleanup.create"

export interface EventMediaPresigner {
  (key: string, opts: { forceSigned: boolean }): Promise<string>
}

interface EventMediaUrls {
  coverUrl: string | null
  galleryUrls: string[]
  organizationLogoUrl: string | null
}

type JurisdictionContact = NonNullable<
  Awaited<ReturnType<CleanupRepository["resolveJurisdictionContact"]>>
>

export interface CleanupServiceDeps {
  repo: CleanupRepository
  tickets: TicketTokenSigner
  audit?: HostAuditSink
  presignEventMedia?: EventMediaPresigner
  presignThumb?: (thumbKey: string) => Promise<string>
  resolveJurisdictionGeoid?: (lat: number, lng: number) => Promise<string | null>
  resolveJurisdictionCode?: (geoid: string | null) => Promise<number>
  /**
   * Only ever called for an OLD client (one that sends no `addressSource`) that also sent no address,
   * via the compat shim in resolveEventAddress. A new client always confirms its own address with the host,
   * which is the whole point of the feature; the server never resolves one behind a host's back.
   */
  resolveAddress?: AddressResolver
  outboundMail?: OutboundMailService
  notifier?: Pick<NotificationService, "createNotification">
  attendeeNotifier?: { eventCancelled(cleanupId: string, reason: string | null): Promise<unknown> }
  counters?: CounterStore
  jobs?: Jobs
  insightsInvalidator?: InsightsInvalidator
  logger?: {
    info(obj: unknown, msg?: string): void
    warn(obj: unknown, msg?: string): void
    error(obj: unknown, msg?: string): void
  }
  newId?: () => string
  now?: () => number
  enrichDTOs?: (dtos: CleanupDTO[], viewerUserId: string | null) => Promise<CleanupDTO[]>
  affiliations?: AffiliationLoader
}

export interface CleanupService {
  createCleanup(input: CreateCleanupRequest, organizerUserId: string): Promise<CleanupDTO>
  duplicateCleanup(actorId: string, input: DuplicateCleanupRequest): Promise<CleanupDTO>
  updateCleanup(
    id: string,
    patch: UpdateCleanupPatchRequest,
    requesterUserId: string,
  ): Promise<CleanupDTO>
  cancelCleanup(id: string, reason: string | null, requesterUserId: string): Promise<CleanupDTO>
  completeCleanup(
    id: string,
    note: string | null,
    requesterUserId: string,
    userAgent?: string | null,
  ): Promise<CleanupDTO>
  listCleanups(
    req: ListCleanupsRequest,
    viewer: CleanupViewer,
  ): Promise<{ items: CleanupDTO[]; nextCursor: string | null }>
  listOrganizationEvents(
    slug: string,
    viewer: CleanupViewer,
    query: { when: "upcoming" | "past"; cursor: string | null; limit: number },
  ): Promise<{ items: CleanupDTO[]; nextCursor: string | null }>
  getCleanup(id: string, viewer: CleanupViewer): Promise<CleanupDTO>
  joinCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }>
  leaveCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }>
  listAttendees(id: string, viewer: CleanupViewer): Promise<CleanupAttendeesResponse>
  setMemberRole(
    id: string,
    actorId: string,
    targetUserId: string,
    role: "cohost" | "staff" | "coordinator" | "member",
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
  const now = deps.now ?? (() => Date.now())
  const presignThumb = deps.presignThumb ?? ((thumbKey: string) => Promise.resolve(thumbKey))
  const counters = deps.counters ?? fallbackCounters
  const audit = deps.audit ?? NULL_HOST_AUDIT_SINK
  const notifications = makeCleanupNotifications(deps)
  function newSignupSeat(): SignupSeat {
    const seatId = randomUUID()
    return { seatId, tokenHash: deps.tickets.hashFor(seatId) }
  }

  const enrichDTOs = deps.enrichDTOs ?? ((dtos: CleanupDTO[]) => Promise.resolve(dtos))

  async function enrichOne(dto: CleanupDTO, viewerUserId: string | null): Promise<CleanupDTO> {
    const [enriched] = await enrichDTOs([dto], viewerUserId)
    return enriched ?? dto
  }

  function standingOf(cleanupId: string, userId: string | null): Promise<HostStanding> {
    if (userId === null) return Promise.resolve(NO_HOST_STANDING)
    return deps.repo.standingOf(cleanupId, userId)
  }

  function standingsOf(
    cleanupIds: string[],
    userId: string | null,
  ): Promise<Map<string, HostStanding>> {
    if (userId === null || cleanupIds.length === 0) return Promise.resolve(new Map())
    return deps.repo.standingsOf(cleanupIds, userId)
  }

  function assertVisible(
    record: { visibility: CleanupRecord["visibility"] },
    standing: HostStanding,
  ): void {
    if (!hasHostStanding(standing) && !isEventPubliclyVisible(record.visibility)) {
      notFoundCleanup()
    }
  }

  function assertCapability(
    record: { visibility: CleanupRecord["visibility"] },
    standing: HostStanding,
    capability: HostCapability,
  ): void {
    assertVisible(record, standing)
    if (!can(standing, capability)) throw AppError.forbidden(hostForbiddenCopy(capability))
  }

  async function requireCapabilityOn(
    cleanupId: string,
    userId: string,
    capability: HostCapability,
  ): Promise<{ record: CleanupRecord; standing: HostStanding }> {
    const [record, standing] = await Promise.all([
      deps.repo.findCleanupById(cleanupId, null),
      standingOf(cleanupId, userId),
    ])
    if (record === null) notFoundCleanup()
    assertCapability(record, standing, capability)
    return { record, standing }
  }

  function capabilityList(standing: HostStanding): HostCapability[] {
    return [...hostCapabilities(standing)]
  }

  async function eventMediaUrls(
    record: CleanupRecord,
    opts: { gallery: boolean },
  ): Promise<EventMediaUrls> {
    const presign = deps.presignEventMedia
    if (presign === undefined) {
      return { coverUrl: null, galleryUrls: [], organizationLogoUrl: null }
    }
    const forceSigned = !isEventPubliclyVisible(record.visibility)
    const [coverUrl, galleryUrls, organizationLogoUrl] = await Promise.all([
      record.coverKey === null ? Promise.resolve(null) : presign(record.coverKey, { forceSigned }),
      opts.gallery && record.galleryMediaIds.length > 0
        ? deps.repo
            .galleryKeysFor(record.id)
            .then((keys) =>
              mapWithLimit(keys, PRESIGN_CONCURRENCY, (key) => presign(key, { forceSigned })),
            )
        : Promise.resolve([]),
      record.organization === null || record.organization.logoKey === null
        ? Promise.resolve(null)
        : presign(record.organization.logoKey, { forceSigned: false }),
    ])
    return { coverUrl, galleryUrls, organizationLogoUrl }
  }

  async function hydrateDetail(
    cleanupId: string,
    record: CleanupRecord,
    standing: HostStanding,
    viewerId: string | null,
    myRole: CleanupMemberRole | null = standing.eventRole,
  ): Promise<CleanupDTO> {
    const [linkedReports, slotBoard, media] = await Promise.all([
      hydrateLinkedReports(cleanupId, record.eventKind),
      hydrateSlots(cleanupId, viewerId),
      eventMediaUrls(record, { gallery: true }),
    ])
    return enrichOne(
      toCleanupDTO(record, isAttending(standing), linkedReports, myRole, {
        slots: slotBoard,
        myCapabilities: capabilityList(standing),
        ...media,
      }),
      viewerId,
    )
  }

  async function hydrateListItems(
    records: CleanupRecord[],
    viewerId: string | null,
    organizationLogoUrl: () => Promise<string | null> = () => Promise.resolve(null),
  ): Promise<CleanupDTO[]> {
    const ids = records.map((r) => r.id)
    const [standingsById, linkedByCleanup, slotCounts, coverUrls, logoUrl] = await Promise.all([
      standingsOf(ids, viewerId),
      hydrateLinkedReportsForMany(records),
      deps.repo.slotCountsFor(ids),
      hydrateCoverUrls(records),
      organizationLogoUrl(),
    ])
    const items = records.map((record) => {
      const standing = standingsById.get(record.id) ?? NO_HOST_STANDING
      return toCleanupDTO(
        record,
        isAttending(standing),
        linkedByCleanup.get(record.id) ?? [],
        standing.eventRole,
        {
          slotCount: slotCounts.get(record.id) ?? 0,
          myCapabilities: capabilityList(standing),
          coverUrl: coverUrls.get(record.id) ?? null,
          organizationLogoUrl: logoUrl,
        },
      )
    })
    return enrichDTOs(items, viewerId)
  }

  async function assertRosterReadBudget(userId: string): Promise<void> {
    const reads = await counters.incr(`host:rosterReads:${userId}`, HOST_ROSTER_READ_WINDOW_SEC)
    if (reads > HOST_ROSTER_READS_PER_HOUR) {
      throw AppError.rateLimited(
        "You've opened attendee lists too many times in the past hour. Please try again later.",
      )
    }
  }

  async function recordRosterView(
    cleanupId: string,
    viewerId: string,
    returned: number,
  ): Promise<void> {
    const seen = await counters.incr(
      `host:rosterAudit:${cleanupId}:${viewerId}`,
      ROSTER_AUDIT_DEDUPE_WINDOW_SEC,
    )
    if (seen !== 1) return
    await audit.record({
      actorId: viewerId,
      action: "event.roster_viewed",
      target: `cleanup:${cleanupId}`,
      meta: { returned },
    })
  }

  async function assertHostEventBudget(userId: string): Promise<void> {
    const created = await counters.incr(`host:events:${userId}`, HOST_EVENTS_WINDOW_SEC)
    if (created > HOST_EVENTS_PER_DAY) {
      throw AppError.rateLimited(
        "You've created the maximum number of events for today. Please try again tomorrow.",
      )
    }
  }

  async function assertMembershipFlipBudget(cleanupId: string, userId: string): Promise<void> {
    const flips = await counters.incr(
      `cleanup:rsvp:${cleanupId}:${userId}`,
      MEMBERSHIP_FLIP_WINDOW_SEC,
    )
    if (flips > MEMBERSHIP_FLIPS_PER_EVENT_PER_WINDOW) {
      throw AppError.rateLimited(
        "You've joined and left this event too many times recently. Please try again later.",
      )
    }
  }

  async function assertRoleChangeBudget(cleanupId: string, targetUserId: string): Promise<void> {
    const flips = await counters.incr(
      `cleanup:role:${cleanupId}:${targetUserId}`,
      ROLE_CHANGE_WINDOW_SEC,
    )
    if (flips > ROLE_CHANGES_PER_TARGET_PER_WINDOW) {
      throw AppError.rateLimited(
        "This attendee's role has been changed too many times recently. Please try again later.",
      )
    }
  }

  async function assertSlotFlipBudget(cleanupId: string, userId: string): Promise<void> {
    const flips = await counters.incr(`cleanup:slot:${cleanupId}:${userId}`, SLOT_FLIP_WINDOW_SEC)
    if (flips > SLOT_FLIPS_PER_EVENT_PER_WINDOW) {
      throw AppError.rateLimited(
        "You've changed your slot too many times recently. Please try again later.",
      )
    }
  }

  async function assertResourceRequestBudget(
    actorId: string,
    jurisdictionGeoid: string | null,
  ): Promise<void> {
    const hostSends = await counters.incr(
      `cleanup:res-req:host:${actorId}`,
      RESOURCE_REQUEST_HOST_WINDOW_SEC,
    )
    // The shared jurisdiction budget is charged only after the host's own cap passes, so one
    // host hammering past its limit cannot exhaust the area for every other host.
    if (hostSends > RESOURCE_REQUEST_PER_HOST_PER_DAY) {
      throw AppError.rateLimited(
        "You've sent the maximum number of resource requests for today. Please try again tomorrow.",
      )
    }
    const jurisdictionSends = await counters.incr(
      `cleanup:res-req:jur:${jurisdictionGeoid ?? UNKNOWN_JURISDICTION_BUDGET_KEY}`,
      RESOURCE_REQUEST_JURISDICTION_WINDOW_SEC,
    )
    if (jurisdictionSends > RESOURCE_REQUEST_PER_JURISDICTION_PER_HOUR) {
      throw AppError.rateLimited(
        "This area has received too many resource requests in the past hour. Please try again later.",
      )
    }
  }

  async function organizationFor(
    organizationId: string | null,
    actorId: string,
    opts: { linking: boolean },
  ): Promise<{
    organization: CleanupOrganizationView | null
    orgRole: OrganizationMemberRole | null
  }> {
    if (organizationId === null) return { organization: null, orgRole: null }
    const [organization, orgRole] = await Promise.all([
      deps.repo.loadOrganizationRef(organizationId),
      deps.repo.orgRoleOf(organizationId, actorId),
    ])
    if (organization === null) {
      throw AppError.validation({ organizationId: "that organization no longer exists" })
    }
    if (opts.linking && orgRole === null) {
      throw AppError.forbidden("Only a member of that organization can host events for it.")
    }
    // An operator-suspended org (DECISIONS §32) keeps its existing events but cannot take on new ones:
    // linking is refused, while an unchanged organizationId on an edit passes so the host can still
    // manage what already exists.
    if (opts.linking && organization.suspended) {
      throw AppError.conflict("That organization is suspended and can't host events right now.")
    }
    return { organization, orgRole }
  }

  async function resolvePageSlug(slug: string, cleanupId: string | null): Promise<string> {
    assertSlugAllowed(slug, "pageSlug")
    const existing = await deps.repo.findCleanupByPageSlug(slug)
    if (existing !== null && existing.id !== cleanupId) {
      throw AppError.conflict("That page address is already taken.")
    }
    return slug
  }

  async function resolveHostWrite(input: {
    patch: HostEventPatch
    actorId: string
    cleanupId: string | null
    current: CleanupRecord | null
  }): Promise<EventHostWrite> {
    const { patch, current } = input
    const write: EventHostWrite = {}

    if (patch.timezone !== undefined) {
      assertValidTimezone(patch.timezone)
      write.timezone = patch.timezone ?? null
    }
    if (patch.visibility !== undefined) write.visibility = patch.visibility
    if (patch.endsAt != null) write.endsAt = new Date(patch.endsAt)
    if (patch.registrationOpensAt !== undefined) {
      write.registrationOpensAt = toDateOrNull(patch.registrationOpensAt)
    }
    if (patch.registrationClosesAt !== undefined) {
      write.registrationClosesAt = toDateOrNull(patch.registrationClosesAt)
    }
    if (patch.reminderOffsetsMinutes !== undefined) {
      assertValidReminderOffsets(patch.reminderOffsetsMinutes)
      write.reminderOffsetsMin = patch.reminderOffsetsMinutes ?? null
    }
    if (patch.coverMediaId !== undefined) write.coverMediaId = patch.coverMediaId ?? null
    if (patch.galleryMediaIds !== undefined) {
      assertGalleryWithinCap(patch.galleryMediaIds)
      write.galleryMediaIds = [...patch.galleryMediaIds]
    }
    if (patch.hostReplyTo !== undefined) write.hostReplyTo = patch.hostReplyTo ?? null
    if (patch.pageSlug !== undefined) {
      write.pageSlug =
        patch.pageSlug === null ? null : await resolvePageSlug(patch.pageSlug, input.cleanupId)
    }

    const effectiveOrgId =
      patch.organizationId !== undefined
        ? (patch.organizationId ?? null)
        : (current?.organizationId ?? null)
    const orgChanged =
      patch.organizationId !== undefined && (current?.organizationId ?? null) !== effectiveOrgId
    if (patch.organizationId !== undefined) write.organizationId = effectiveOrgId
    await organizationFor(effectiveOrgId, input.actorId, {
      linking: orgChanged || current === null,
    })

    if (patch.donationUrl !== undefined) write.donationUrl = patch.donationUrl ?? null

    assertEventWindow({
      scheduledAt:
        patch.scheduledAt !== undefined
          ? new Date(patch.scheduledAt)
          : (current?.scheduledAt ?? new Date(0)),
      endsAt: write.endsAt !== undefined ? write.endsAt : (current?.endsAt ?? null),
      registrationOpensAt:
        write.registrationOpensAt !== undefined
          ? write.registrationOpensAt
          : (current?.registrationOpensAt ?? null),
      registrationClosesAt:
        write.registrationClosesAt !== undefined
          ? write.registrationClosesAt
          : (current?.registrationClosesAt ?? null),
    })
    return write
  }

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

  function notFoundOrganization(): never {
    throw AppError.notFound("Organization not found")
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

  async function resolveCreateLinks(
    requested: string[] | undefined,
    eventKind: EventKind,
  ): Promise<string[]> {
    const linkedReportIds = clampLinkIds(requested ?? [])
    if (eventKind !== "cleanup" && linkedReportIds.length > 0) {
      throw AppError.validation({ linkedReportIds: ONLY_CLEANUPS_LINK_REPORTS_MESSAGE })
    }
    await assertReportsLinkable(linkedReportIds)
    return linkedReportIds
  }

  /** null leaves the stored links untouched; a non-cleanup event always clears them. */
  async function resolveEditedLinks(
    requested: string[] | undefined,
    effectiveKind: EventKind,
  ): Promise<string[] | null> {
    if (requested !== undefined && effectiveKind !== "cleanup") {
      throw AppError.validation({ linkedReportIds: ONLY_CLEANUPS_LINK_REPORTS_MESSAGE })
    }
    const desiredLinks =
      requested !== undefined ? clampLinkIds(requested) : effectiveKind !== "cleanup" ? [] : null
    if (desiredLinks !== null && desiredLinks.length > 0) {
      await assertReportsLinkable(desiredLinks)
    }
    return desiredLinks
  }

  async function resolveEditedSlots(
    cleanupId: string,
    requested: UpdateCleanupPatchRequest["slots"],
    edited: { window: EventWindow; moved: boolean },
  ): Promise<DesiredSlot[] | null> {
    if (requested !== undefined && requested.length === 0) {
      throw AppError.validation({ slots: EVENT_NEEDS_A_SLOT_MESSAGE })
    }
    if (requested === undefined) {
      if (edited.moved) {
        assertTimedSlotsFitWindow(await deps.repo.listSlots(cleanupId, null), edited.window)
      }
      return null
    }
    const desiredSlots = toDesiredSlots(requested, { keepIds: true }, edited.window)
    assertKnownSlotIds(desiredSlots, await deps.repo.listSlots(cleanupId, null))
    return desiredSlots
  }

  /**
   * Authz plus the cancelled/ended freezes. Returns the ended-event refusal (or null) because the
   * transactional write re-checks it under its own lock: the event can end between here and there.
   */
  function assertEditable(
    current: CleanupRecord,
    standing: HostStanding,
    patch: UpdateCleanupPatchRequest,
  ): AppError | null {
    assertCapability(current, standing, "manage_event")
    if (patch.organizationId !== undefined && patch.organizationId !== current.organizationId) {
      assertCapability(current, standing, "manage_org_link")
    }
    if (current.status === "cancelled") {
      throw AppError.conflict(CANCELLED_EVENT_EDIT_MESSAGE)
    }
    const hasEnded = deriveCleanupStatus(eventWindowOf(current), now()) === "done"
    const endedRefusal = refusalOnceEnded(patch, current)
    if (hasEnded && endedRefusal !== null) throw endedRefusal
    assertScheduledAtNotBackdated(patch.scheduledAt, current.scheduledAt, now())
    return endedRefusal
  }

  async function resolveJurisdiction(
    lat: number,
    lng: number,
  ): Promise<{ jurisdictionGeoid: string | null; jurCode: number }> {
    const jurisdictionGeoid =
      deps.resolveJurisdictionGeoid !== undefined
        ? await deps.resolveJurisdictionGeoid(lat, lng)
        : null
    const jurCode =
      deps.resolveJurisdictionCode !== undefined
        ? await deps.resolveJurisdictionCode(jurisdictionGeoid)
        : UNKNOWN_JURCODE
    return { jurisdictionGeoid, jurCode }
  }

  async function resolveEditedScalars(
    cleanupId: string,
    patch: UpdateCleanupPatchRequest,
    current: CleanupRecord,
    actorId: string,
  ): Promise<UpdateCleanupPatch> {
    const addressPatch = eventAddressPatch(patch)
    const movedTo =
      patch.lat !== undefined && patch.lng !== undefined ? { lat: patch.lat, lng: patch.lng } : null
    const reresolvedGeoid =
      movedTo !== null && deps.resolveJurisdictionGeoid !== undefined
        ? await deps.resolveJurisdictionGeoid(movedTo.lat, movedTo.lng)
        : undefined
    const host = await resolveHostWrite({ patch, actorId, cleanupId, current })
    return {
      ...host,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.eventKind !== undefined ? { eventKind: patch.eventKind } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.scheduledAt !== undefined ? { scheduledAt: new Date(patch.scheduledAt) } : {}),
      ...(movedTo ?? {}),
      ...addressPatch,
      ...(patch.bring !== undefined ? { bring: patch.bring } : {}),
      ...(reresolvedGeoid !== undefined ? { jurisdictionGeoid: reresolvedGeoid } : {}),
    }
  }

  async function announceUpdate(
    record: CleanupRecord,
    slotDiff: SlotReconcileResult | null,
    current: CleanupRecord,
    patch: UpdateCleanupPatchRequest,
  ): Promise<void> {
    if (slotDiff !== null) {
      await notifications.notifySlotChanges(record, slotDiff)
    }
    if (
      deriveCleanupStatus(eventWindowOf(record), now()) !== "done" &&
      guestVisibleChange(current, patch)
    ) {
      await notifications.dispatchGuestUpdateFanout(record.id)
    }
  }

  async function hydrateCoverUrls(records: CleanupRecord[]): Promise<Map<string, string>> {
    const presign = deps.presignEventMedia
    const out = new Map<string, string>()
    if (presign === undefined) return out
    const withCover = records.filter((r) => r.coverKey !== null)
    const urls = await mapWithLimit(withCover, PRESIGN_CONCURRENCY, (record) =>
      presign(record.coverKey as string, {
        forceSigned: !isEventPubliclyVisible(record.visibility),
      }),
    )
    withCover.forEach((record, i) => {
      const url = urls[i]
      if (url !== undefined) out.set(record.id, url)
    })
    return out
  }

  async function hydrateSlots(cleanupId: string, viewerId: string | null): Promise<EventSlotDTO[]> {
    const views = await deps.repo.listSlots(cleanupId, viewerId)
    return views.map(toEventSlotDTO)
  }

  async function createEvent(
    input: CreateCleanupRequest,
    organizerUserId: string,
    copyFrom?: DuplicateSource,
  ): Promise<CleanupDTO> {
    assertEventTextClean(input)
    clampBring(input.bring)
    const linkedReportIds = await resolveCreateLinks(input.linkedReportIds, input.eventKind)
    const addressWrite = await resolveEventAddress(input, deps.resolveAddress, {
      fromStoredEvent: copyFrom !== undefined,
    })
    const { scheduledAt, endsAt, slots } = plannedEventWindow(input)

    const host = await resolveHostWrite({
      patch: { ...input, scheduledAt: input.scheduledAt, endsAt: endsAt.toISOString() },
      actorId: organizerUserId,
      cleanupId: null,
      current: null,
    })
    await assertHostEventBudget(organizerUserId)

    const { jurisdictionGeoid, jurCode } = await resolveJurisdiction(input.lat, input.lng)

    const cleanupId = newId()
    const outcome = await deps.repo.createCleanupTx({
      cleanupId,
      organizerUserId,
      type: input.type,
      eventKind: input.eventKind,
      title: input.title,
      description: input.description ?? null,
      lat: input.lat,
      lng: input.lng,
      scheduledAt,
      status: "upcoming",
      bring: input.bring ?? null,
      address: addressWrite.address,
      addressSource: addressWrite.addressSource,
      jurisdictionGeoid,
      jurCode,
      linkedReportIds,
      slots,
      host: { ...host, endsAt },
      ...(copyFrom !== undefined ? { copyFrom } : {}),
      ...(input.idempotencyKey !== undefined
        ? {
            idempotency: {
              key: input.idempotencyKey,
              scope: CLEANUP_CREATE_IDEMPOTENCY_SCOPE,
              userOrAnon: `user:${organizerUserId}`,
            },
          }
        : {}),
    })
    const record = outcome.record
    const standing = await standingOf(record.id, organizerUserId)
    return hydrateDetail(record.id, record, standing, organizerUserId)
  }

  async function resolveDuplicateOrganization(
    organizationId: string | null,
    actorId: string,
  ): Promise<string | null> {
    if (organizationId === null) return null
    try {
      await organizationFor(organizationId, actorId, { linking: true })
    } catch (err) {
      if (!isHostRefusal(err)) throw err
      return null
    }
    return organizationId
  }

  async function sendResourceRequest(
    outboundMail: OutboundMailService,
    record: CleanupRecord,
    routing: JurisdictionContact,
    message: string,
  ): Promise<void> {
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
      message,
    )
    await outboundMail.sendEventToJurisdiction({
      cleanupId: record.id,
      geoid: record.jurisdictionGeoid,
      org: routing.name,
      toAddr: routing.contact,
      subject: packet.subject,
      text: packet.text,
      html: packet.html,
    })
  }

  return {
    createCleanup(input: CreateCleanupRequest, organizerUserId: string): Promise<CleanupDTO> {
      return createEvent(input, organizerUserId)
    },

    async duplicateCleanup(actorId: string, input: DuplicateCleanupRequest): Promise<CleanupDTO> {
      if (input.endsAt === null) throw AppError.validation({ endsAt: "required" })
      const { record: source } = await requireCapabilityOn(input.id, actorId, "manage_event")
      const organizationId = await resolveDuplicateOrganization(source.organizationId, actorId)
      const copiedAt = new Date(now())
      const slots = await deps.repo.listSlots(source.id, null)
      const copy = duplicateRequestOf(source, slots, input, organizationId, copiedAt)
      return createEvent(copy, actorId, {
        cleanupId: source.id,
        ticketTypes: input.includeTicketTypes,
        questions: input.includeQuestions,
        page: input.includePage,
      })
    },

    async updateCleanup(
      id: string,
      patch: UpdateCleanupPatchRequest,
      requesterUserId: string,
    ): Promise<CleanupDTO> {
      assertEventTextClean(patch)
      clampBring(patch.bring)
      const standing = await standingOf(id, requesterUserId)
      const current = await deps.repo.findCleanupById(id, null)
      if (!current) notFoundCleanup()
      const endedRefusal = assertEditable(current, standing, patch)
      const desiredLinks = await resolveEditedLinks(
        patch.linkedReportIds,
        patch.eventKind ?? current.eventKind,
      )
      const edited = editedWindowOf(current, patch)
      const desiredSlots = await resolveEditedSlots(id, patch.slots, edited)
      const scalarPatch = await resolveEditedScalars(id, patch, current, requesterUserId)

      const outcome = await deps.repo.updateCleanupWithEdits(id, scalarPatch, {
        actorUserId: requesterUserId,
        links: desiredLinks,
        slots: desiredSlots,
        refusalOnceEnded: endedRefusal,
      })
      if (outcome.kind === "not_found") notFoundCleanup()
      if (outcome.kind === "cancelled") throw AppError.conflict(CANCELLED_EVENT_EDIT_MESSAGE)

      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()
      await announceUpdate(record, outcome.slotDiff, current, patch)
      return hydrateDetail(id, record, standing, requesterUserId)
    },

    async cancelCleanup(
      id: string,
      reason: string | null,
      requesterUserId: string,
    ): Promise<CleanupDTO> {
      const { standing } = await requireCapabilityOn(id, requesterUserId, "cancel_event")
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
      if (outcome === "already_ended") {
        throw AppError.conflict("This event has already ended and can't be cancelled.")
      }

      await deps.insightsInvalidator?.bumpInsightsGeneration(id)

      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()
      if (outcome === "cancelled") {
        await notifications.dispatchCancelFanout(record, cleanReason, requesterUserId)
      }
      return hydrateDetail(id, record, standing, requesterUserId, standing.eventRole ?? "organizer")
    },

    async completeCleanup(
      id: string,
      note: string | null,
      requesterUserId: string,
      userAgent: string | null = null,
    ): Promise<CleanupDTO> {
      const { standing } = await requireCapabilityOn(id, requesterUserId, "manage_event")
      const trimmed = note?.trim()
      assertNoSlur(trimmed && trimmed.length > 0 ? trimmed : null, "note")
      deps.logger?.info({ cleanupId: id, userAgent }, "cleanup.complete.deprecated")

      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()
      return hydrateDetail(id, record, standing, requesterUserId)
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
      return { items: await hydrateListItems(records, viewer.userId), nextCursor }
    },

    async listOrganizationEvents(
      slug: string,
      viewer: CleanupViewer,
      query: { when: "upcoming" | "past"; cursor: string | null; limit: number },
    ): Promise<{ items: CleanupDTO[]; nextCursor: string | null }> {
      const host = await deps.repo.findOrganizationEventsHost(slug, viewer.userId)
      if (host === null) notFoundOrganization()
      if (host.organization.suspended && !host.viewerIsMember) notFoundOrganization()

      const { records, nextCursor } = await deps.repo.listOrganizationEvents({
        organizationId: host.organization.id,
        when: query.when,
        cursor: query.cursor,
        limit: query.limit,
      })
      const presign = deps.presignEventMedia
      const logoKey = host.organization.logoKey
      const items = await hydrateListItems(records, viewer.userId, () =>
        logoKey === null || presign === undefined
          ? Promise.resolve(null)
          : presign(logoKey, { forceSigned: false }),
      )
      return { items, nextCursor }
    },

    async getCleanup(id: string, viewer: CleanupViewer): Promise<CleanupDTO> {
      const record = isUuid(id)
        ? await deps.repo.findCleanupById(id, null)
        : ((await deps.repo.findCleanupByReferenceCode(id)) ??
          (await deps.repo.findCleanupByPageSlug(id)))
      if (!record) notFoundCleanup()
      const standing = await standingOf(record.id, viewer.userId)
      assertVisible(record, standing)
      return hydrateDetail(record.id, record, standing, viewer.userId)
    },

    async joinCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }> {
      await assertMembershipFlipBudget(id, userId)
      const outcome = await deps.repo.joinCleanupTx(id, userId, newSignupSeat())
      if (outcome === "not_found") notFoundCleanup()
      if (outcome === "banned") throw AppError.forbidden(REMOVED_BY_HOST_MESSAGE)
      if (outcome === "closed") throw AppError.conflict(EVENT_CLOSED_MESSAGE)
      if (outcome === "ended") throw eventEndedError()
      await deps.insightsInvalidator?.bumpInsightsGeneration(id)
      const going = await deps.repo.goingCount(id)
      return { joined: true, going }
    },

    async leaveCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }> {
      await assertMembershipFlipBudget(id, userId)
      const organizerId = await deps.repo.organizerOf(id)
      if (organizerId === null) notFoundCleanup()
      if (organizerId === userId) {
        throw AppError.conflict("The organizer cannot leave their own cleanup.")
      }
      const outcome = await deps.repo.leaveCleanup(id, userId)
      if (outcome === "not_found") notFoundCleanup()
      if (outcome === "closed") throw AppError.conflict(EVENT_CLOSED_MESSAGE)
      await deps.insightsInvalidator?.bumpInsightsGeneration(id)
      const going = await deps.repo.goingCount(id)
      return { joined: false, going }
    },

    async listAttendees(id: string, viewer: CleanupViewer): Promise<CleanupAttendeesResponse> {
      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()

      const standing = await standingOf(id, viewer.userId)
      assertVisible(record, standing)
      const joined = viewer.userId !== null && (await deps.repo.isMember(id, viewer.userId))
      const scope: CleanupAttendeesResponse["scope"] = joined ? "all" : "following"

      const actsAsHost = viewer.userId !== null && can(standing, "view_roster")
      if (actsAsHost && viewer.userId !== null) await assertRosterReadBudget(viewer.userId)
      const views = await deps.repo.listAttendees({
        cleanupId: id,
        viewerId: viewer.userId,
        onlyFollowed: !joined,
        limit: actsAsHost ? EVENT_HOURS_MEMBER_CAP : ATTENDEES_DEFAULT_LIMIT,
      })
      if (actsAsHost && viewer.userId !== null) {
        await recordRosterView(id, viewer.userId, views.length)
      }
      const attendees = await attachAffiliations(
        deps.affiliations,
        views.map((v) => toAttendeeDTO(v, v.isFollowing)),
        viewer.userId,
      )
      return { attendees, going: record.going, scope }
    },

    async setMemberRole(
      id: string,
      actorId: string,
      targetUserId: string,
      role: "cohost" | "staff" | "coordinator" | "member",
    ): Promise<SetMemberRoleResponse> {
      const { record, standing } = await requireCapabilityOn(id, actorId, "manage_team")
      assertMayGrantRole(standing, role)
      if (targetUserId === record.organizerUserId) {
        throw AppError.forbidden("The organizer's role can't be changed.")
      }
      if (targetUserId === actorId) {
        throw AppError.conflict("You can't change your own role on this event.")
      }
      const targetRole = await deps.repo.roleOf(id, targetUserId)
      if (targetRole === null) {
        if (role === "member" && (await deps.repo.isBanned(id, targetUserId))) {
          await deps.repo.unbanMember(id, targetUserId)
          return { ok: true }
        }
        throw AppError.notFound(NOT_ATTENDING_MESSAGE)
      }
      if (targetRole === role) return { ok: true }

      await assertRoleChangeBudget(id, targetUserId)

      const flipped = await deps.repo.setMemberRole(id, targetUserId, role)
      if (!flipped) throw AppError.notFound(NOT_ATTENDING_MESSAGE)

      await audit.record({
        actorId,
        action: "event.team_role_changed",
        target: `cleanup:${id}`,
        meta: { targetUserId, from: targetRole, to: role },
      })
      await notifications.notifyRoleChange(
        targetUserId,
        role === "member" ? "demoted" : "promoted",
        { id: record.id, title: record.title },
      )
      return { ok: true }
    },

    async removeMember(
      id: string,
      actorId: string,
      targetUserId: string,
    ): Promise<RemoveMemberResponse> {
      const { record, standing } = await requireCapabilityOn(id, actorId, "manage_event")
      if (targetUserId === actorId) {
        throw AppError.conflict("You can't remove yourself. Leave the event instead.")
      }
      if (targetUserId === record.organizerUserId) {
        throw AppError.forbidden("The organizer can't be removed from their own event.")
      }
      const targetRole = await deps.repo.roleOf(id, targetUserId)
      if (targetRole === null) {
        throw AppError.notFound(NOT_ATTENDING_MESSAGE)
      }
      if (targetRole !== "member" && !can(standing, "manage_team")) {
        throw AppError.forbidden(hostForbiddenCopy("manage_team"))
      }

      const outcome = await deps.repo.removeMember(id, targetUserId, actorId)
      if (outcome.kind === "not_found") notFoundCleanup()
      if (outcome.kind === "closed") throw AppError.conflict(EVENT_CLOSED_MESSAGE)
      if (outcome.kind === "not_member") {
        throw AppError.notFound(NOT_ATTENDING_MESSAGE)
      }

      await enqueueWaitlistPromotion(deps.jobs, outcome.releasedWaitlistTicketTypeIds, deps.logger)
      await deps.insightsInvalidator?.bumpInsightsGeneration(id)

      await audit.record({
        actorId,
        action: "event.attendee_removed",
        target: `cleanup:${id}`,
        meta: { targetUserId, role: targetRole },
      })
      await notifications.notifyRoleChange(targetUserId, "removed", {
        id: record.id,
        title: record.title,
      })
      return { ok: true, going: outcome.going }
    },

    async claimEventSlot(id: string, userId: string, slotId: string | null): Promise<CleanupDTO> {
      await assertSlotFlipBudget(id, userId)

      const [record, standing] = await Promise.all([
        deps.repo.findCleanupById(id, null),
        standingOf(id, userId),
      ])
      if (record === null) notFoundCleanup()
      assertVisible(record, standing)

      const outcome =
        slotId === null
          ? await deps.repo.releaseSlot(id, userId)
          : await deps.repo.claimSlot(id, userId, slotId, newSignupSeat())

      if (outcome.kind === "not_found") notFoundCleanup()
      if (outcome.kind === "slot_not_found") {
        throw AppError.notFound("That slot no longer exists.")
      }
      if (outcome.kind === "banned") throw AppError.forbidden(REMOVED_BY_HOST_MESSAGE)
      if (outcome.kind === "closed") throw AppError.conflict(EVENT_CLOSED_MESSAGE)
      if (outcome.kind === "ended") throw eventEndedError()
      if (outcome.kind === "full") throw AppError.conflict("That slot is already full.")

      await deps.insightsInvalidator?.bumpInsightsGeneration(id)

      const updated = await deps.repo.findCleanupById(id, null)
      if (!updated) notFoundCleanup()
      const nextStanding = await standingOf(id, userId)
      return hydrateDetail(id, updated, nextStanding, userId)
    },

    async requestResources(input: {
      cleanupId: string
      message: string
      actorId: string
    }): Promise<RequestEventResourcesResponse> {
      const outboundMail = deps.outboundMail
      if (outboundMail === undefined) {
        throw AppError.internal("Event resource requests are not available")
      }
      const { record, standing } = await requireCapabilityOn(
        input.cleanupId,
        input.actorId,
        "request_resources",
      )
      if (record.organization === null) {
        throw AppError.forbidden(
          "Only an event hosted by an organization can request city resources.",
        )
      }
      assertCapability(record, standing, "manage_event")

      assertNoSlur(input.message, "message")

      const routing = await deps.repo.resolveJurisdictionContact(record.jurisdictionGeoid)
      if (routing === null) {
        throw AppError.notRoutable(
          "This event's area has no jurisdiction contact on file, so resources can't be requested yet.",
        )
      }

      await assertResourceRequestBudget(input.actorId, record.jurisdictionGeoid)
      await sendResourceRequest(outboundMail, record, routing, input.message)

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
      await notifications.notifyCancellation(
        { id: record.id, title: record.title },
        job.reason,
        job.actorId,
      )
    },
  }
}

function guestVisibleChange(
  current: { scheduledAt: Date; address: string | null; lat: number; lng: number },
  patch: UpdateCleanupPatchRequest,
): boolean {
  if (patch.scheduledAt !== undefined) {
    const next = Date.parse(patch.scheduledAt)
    if (!Number.isNaN(next) && next !== current.scheduledAt.getTime()) return true
  }
  if (patch.address !== undefined && (patch.address ?? null) !== current.address) return true
  // The contract lets lat and lng arrive alone, but the location only moves when both do.
  if (patch.lat !== undefined && patch.lng !== undefined) {
    if (patch.lat !== current.lat || patch.lng !== current.lng) return true
  }
  return false
}

function resourceRequestNote(message: string): string {
  const collapsed = collapseWhitespace(message)
  const preview =
    collapsed.length > RESOURCE_NOTE_PREVIEW_CHARS
      ? `${collapsed.slice(0, RESOURCE_NOTE_PREVIEW_CHARS)}…`
      : collapsed
  return preview.length > 0 ? `Resources requested: ${preview}` : "Resources requested"
}
