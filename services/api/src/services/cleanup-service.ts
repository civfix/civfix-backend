import { randomUUID } from "node:crypto"
import {
  AppError,
  ErrorCode,
  MAX_BRING_ITEMS,
  MAX_EVENT_ADDRESS_LENGTH,
  MAX_EVENT_SLOTS,
  MIN_SLOT_DURATION_MINUTES,
} from "@civfix/shared"
import { can, hostCapabilities, NO_HOST_STANDING, type HostStanding } from "@civfix/shared/host"
import { UNKNOWN_JURCODE } from "../db/reference-code.js"
import { assertNoSlur } from "../abuse/slur-filter.js"
import { InMemoryCounterStore, type CounterStore } from "../abuse/counter-store.js"
import type {
  CleanupAttendeesResponse,
  CleanupDTO,
  CreateCleanupRequest,
  DuplicateCleanupRequest,
  EventAddressSource,
  EventKind,
  EventSlotDTO,
  EventSlotInput,
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
import { isLocatedPrecision } from "@civfix/shared"
import type { AddressResolver } from "./address-resolver.js"
import type { NotificationService } from "./notification-service.js"
import type { MessageKey } from "../i18n/messages/en.js"
import { EVENT_HOURS_MEMBER_CAP } from "./volunteer-hours-service.js"
import type { OutboundMailService } from "./admin/outbound-mail-service.js"
import { buildEventPacket } from "./admin/mail-format.js"
import { PRESIGN_CONCURRENCY, mapWithLimit } from "./media-presign.js"
import { attachAffiliations, type AffiliationLoader } from "./affiliation.js"
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
import { CLEANUP_GUEST_UPDATE_FANOUT_JOB, type GuestUpdateFanoutJob } from "./guest-rsvp-service.js"

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

export type UpdateCleanupPatchRequest = Omit<UpdateCleanupRequest, "id">

export type HostEventPatch = Pick<
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

const EVENT_CLOSED_MESSAGE = "This event is closed."

/**
 * Floor for a host-confirmed event address. Long enough to reject the accidental keystroke and the
 * lone punctuation mark, short enough to allow a genuinely terse one ("Pier 3").
 */
const MIN_EVENT_ADDRESS_LENGTH = 3

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

export const MEMBERSHIP_FLIPS_PER_EVENT_PER_WINDOW = 20
const MEMBERSHIP_FLIP_WINDOW_SEC = 60 * 60

export const CANCEL_FANOUT_MEMBER_CAP = 2000

interface SlotFanoutBudget {
  remaining: number
}

const CANCEL_FANOUT_CONCURRENCY = 8

const fallbackCounters = new InMemoryCounterStore()

export const CLEANUP_CANCEL_FANOUT_JOB = "cleanup.cancel.fanout"

export const CANCEL_FANOUT_DEDUPE_WINDOW_MS = 60 * 60 * 1000

export interface CleanupCancelFanoutJob {
  cleanupId: string
  reason: string | null
  actorId: string
}

export const HOST_EVENTS_PER_DAY = 10
export const HOST_EVENTS_WINDOW_SEC = 24 * 60 * 60

export const HOST_ROSTER_READS_PER_HOUR = 200
const HOST_ROSTER_READ_WINDOW_SEC = 60 * 60

const ROSTER_AUDIT_DEDUPE_WINDOW_SEC = 60 * 60

export const CLEANUP_CREATE_IDEMPOTENCY_SCOPE = "cleanup.create"

export interface EventMediaPresigner {
  (key: string, opts: { forceSigned: boolean }): Promise<string>
}

export interface CleanupServiceDeps {
  repo: CleanupRepository
  tickets: TicketTokenSigner
  audit?: HostAuditSink
  presignEventMedia?: EventMediaPresigner
  presignThumb?: (thumbKey: string) => Promise<string>
  resolveJurisdictionGeoid?: (lat: number, lng: number) => Promise<string | null>
  resolveJurisdictionCode?: (geoid: string | null) => Promise<number>
  /**
   * Only ever called for an OLD client (one that sends no `addressSource`) that also sent no address —
   * the compat shim in resolveEventAddress. A new client always confirms its own address with the host,
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
  const presignThumb = deps.presignThumb ?? ((thumbKey: string) => Promise.resolve(thumbKey))
  const counters = deps.counters ?? fallbackCounters
  const audit = deps.audit ?? NULL_HOST_AUDIT_SINK
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
  ): Promise<{
    coverUrl: string | null
    galleryUrls: string[]
    organizationLogoUrl: string | null
  }> {
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

  async function assertRosterReadBudget(userId: string): Promise<void> {
    const reads = await counters.incr(`host:rosterReads:${userId}`, HOST_ROSTER_READ_WINDOW_SEC)
    if (reads > HOST_ROSTER_READS_PER_HOUR) {
      throw AppError.rateLimited(
        "You've opened attendee lists too many times in the past hour. Please try again later.",
      )
    }
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

  /**
   * The event address, with its provenance, for a create or an update.
   *
   * `addressSource` is the CLIENT-VERSION discriminator, and it has to be: `address` itself stays
   * optional on the wire so the TestFlight build in someone's pocket keeps working.
   *
   *   addressSource PRESENT  -> a new client. It resolved the pin, showed the line to the host, and the
   *                             host published with it on screen. That is the confirmation, so the
   *                             server only has to refuse a blank one — a client that sends a source
   *                             without an address has a bug, and storing it would produce an event
   *                             whose address is "verified" and empty.
   *   addressSource ABSENT   -> an old client. Whatever it sent in `address` is the host's own "name the
   *                             spot" text, so it is 'manual' (the same call migration 0179 makes for
   *                             existing rows). If it sent nothing, the shim resolves the pin and stores
   *                             'resolved' — unverified, but an event with a street line beats an event
   *                             with "Meeting point", and only while old clients are still in the wild.
   *
   * The shim stores NOTHING when the ladder only reached `locality`: "Los Angeles, CA" is not a meeting
   * address, and writing it would dress up a non-answer as a host-provided one.
   *
   * `fromStoredEvent` marks the DUPLICATE path, whose pair did not come off the wire at all: it is this
   * server's own stored row, copied verbatim. The new-client length floor is a check on a client payload
   * and would reject a backfilled one-or-two-character address that the host has been running for
   * months. Slur checks still apply - they run over the whole input before this.
   */
  async function resolveEventAddress(
    input: {
      address?: string | undefined
      addressSource?: EventAddressSource | undefined
      lat: number
      lng: number
    },
    opts?: { fromStoredEvent?: boolean },
  ): Promise<{ address: string | null; addressSource: EventAddressSource | null }> {
    if (input.addressSource !== undefined) {
      if (opts?.fromStoredEvent === true && input.address !== undefined) {
        return { address: input.address, addressSource: input.addressSource }
      }
      return { address: assertConfirmedAddress(input.address), addressSource: input.addressSource }
    }
    const typed = input.address?.trim() ?? ""
    if (typed.length > 0) return { address: typed, addressSource: "manual" }
    if (deps.resolveAddress === undefined) return { address: null, addressSource: null }
    const resolved = await deps.resolveAddress(input.lat, input.lng)
    if (resolved.address === null || !isLocatedPrecision(resolved.precision)) {
      return { address: null, addressSource: null }
    }
    return {
      address: resolved.address.slice(0, MAX_EVENT_ADDRESS_LENGTH),
      addressSource: "resolved",
    }
  }

  /** A new client that names a source must carry a real line with it. */
  function assertConfirmedAddress(address: string | undefined): string {
    const trimmed = address?.trim() ?? ""
    if (trimmed.length < MIN_EVENT_ADDRESS_LENGTH) {
      throw AppError.validation({
        address: `must be at least ${MIN_EVENT_ADDRESS_LENGTH} characters`,
      })
    }
    return trimmed
  }

  /** The update-path twin of resolveEventAddress: same rules, but every field stays optional. */
  function eventAddressPatch(patch: {
    address?: string | undefined
    addressSource?: EventAddressSource | undefined
  }): { address?: string | null; addressSource?: EventAddressSource | null } {
    if (patch.addressSource !== undefined) {
      return { address: assertConfirmedAddress(patch.address), addressSource: patch.addressSource }
    }
    if (patch.address === undefined) return {}
    const trimmed = patch.address.trim()
    return trimmed.length > 0
      ? { address: trimmed, addressSource: "manual" }
      : { address: null, addressSource: null }
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
    await notifyAttendeesOfCancellation(cleanup.id, reason)
  }

  async function notifyAttendeesOfCancellation(
    cleanupId: string,
    reason: string | null,
  ): Promise<void> {
    if (deps.attendeeNotifier === undefined) return
    await deps.attendeeNotifier.eventCancelled(cleanupId, reason)
  }

  async function dispatchGuestUpdateFanout(cleanupId: string): Promise<void> {
    if (deps.jobs === undefined) {
      deps.logger?.warn(
        { cleanupId },
        "cleanup.guest.update.fanout: no job queue wired; guests are not notified",
      )
      return
    }
    try {
      await deps.jobs.enqueue(
        CLEANUP_GUEST_UPDATE_FANOUT_JOB,
        { cleanupId } satisfies GuestUpdateFanoutJob,
        { singletonKey: cleanupId },
      )
    } catch (err) {
      deps.logger?.error(
        { err, cleanupId },
        "cleanup.guest.update.fanout enqueue failed; guests are not notified",
      )
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
          dedupeWindowMs: CANCEL_FANOUT_DEDUPE_WINDOW_MS,
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
        deps.logger?.error(
          { err, cleanupId: cleanup.id },
          "cleanup.cancel.fanout enqueue failed; ringing members inline, guests are not notified",
        )
      }
    }
    try {
      await notifyMembersOfCancellation(cleanup, reason, actorId)
    } catch (err) {
      deps.logger?.warn(
        { err, cleanupId: cleanup.id },
        "cleanup_cancelled inline member fanout failed (suppressed; the cancellation itself stands)",
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

  function slotWindowOf(slot: EventSlotInput): { startsAt: Date | null; endsAt: Date | null } {
    const startsAt = slot.startsAt != null ? new Date(slot.startsAt) : null
    const endsAt = slot.endsAt != null ? new Date(slot.endsAt) : null
    return { startsAt, endsAt }
  }

  function assertSlotInsideEvent(
    title: string,
    window: { startsAt: Date; endsAt: Date },
    event: EventWindow,
  ): void {
    if (event.endsAt === null) {
      throw AppError.validation({
        slots: "set an end time for the event before adding timed slots",
      })
    }
    if (window.startsAt < event.scheduledAt || window.endsAt > event.endsAt) {
      throw AppError.validation({
        slots: `slot "${title}" falls outside the event's start and end`,
      })
    }
    if (window.endsAt.getTime() - window.startsAt.getTime() < MIN_SLOT_DURATION_MINUTES * 60_000) {
      throw AppError.validation({
        slots: `slot "${title}" must last at least ${MIN_SLOT_DURATION_MINUTES} minutes`,
      })
    }
  }

  function toDesiredSlots(
    slots: EventSlotInput[],
    opts: { keepIds: boolean },
    window: EventWindow,
  ): DesiredSlot[] {
    if (slots.length > MAX_EVENT_SLOTS) {
      throw AppError.validation({ slots: `at most ${MAX_EVENT_SLOTS} slots may be listed` })
    }
    const seen = new Set<string>()
    for (const slot of slots) {
      const { startsAt, endsAt } = slotWindowOf(slot)
      if (startsAt !== null && endsAt !== null) {
        assertSlotInsideEvent(slot.title, { startsAt, endsAt }, window)
      }
      const key = `${slot.title.trim().toLowerCase()}|${startsAt?.getTime() ?? ""}|${endsAt?.getTime() ?? ""}`
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
      ...slotWindowOf(slot),
      sortOrder: slot.sortOrder ?? index,
    }))
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

  async function notifySlotClaimants(
    cleanup: { id: string; title: string },
    entries: SlotReconcileResult["removed"],
    keys: { titleKey: MessageKey; bodyKey: MessageKey },
    budget: SlotFanoutBudget,
  ): Promise<void> {
    const notifier = deps.notifier
    if (notifier === undefined) return
    const targets: { userId: string; slot: string }[] = []
    for (const entry of entries) {
      for (const userId of entry.claimantUserIds) {
        if (budget.remaining <= 0) break
        budget.remaining -= 1
        targets.push({ userId, slot: entry.title })
      }
    }
    await mapWithLimit(targets, CANCEL_FANOUT_CONCURRENCY, async ({ userId, slot }) => {
      try {
        await notifier.createNotification(userId, {
          type: "cleanup_slot",
          titleKey: keys.titleKey,
          bodyKey: keys.bodyKey,
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

  async function notifySlotChanges(
    cleanup: { id: string; title: string },
    diff: SlotReconcileResult,
  ): Promise<void> {
    const budget: SlotFanoutBudget = { remaining: CANCEL_FANOUT_MEMBER_CAP }
    if (diff.removed.length > 0) {
      await notifySlotClaimants(
        cleanup,
        diff.removed,
        {
          titleKey: "notification.cleanup_slot.removed.title",
          bodyKey: "notification.cleanup_slot.removed.body",
        },
        budget,
      )
    }
    if (diff.rescheduled.length > 0) {
      await notifySlotClaimants(
        cleanup,
        diff.rescheduled,
        {
          titleKey: "notification.cleanup_slot.moved.title",
          bodyKey: "notification.cleanup_slot.moved.body",
        },
        budget,
      )
    }
  }

  async function createEvent(
    input: CreateCleanupRequest,
    organizerUserId: string,
    copyFrom?: DuplicateSource,
  ): Promise<CleanupDTO> {
    assertEventTextClean(input)
    clampBring(input.bring)
    const linkedReportIds = clampLinkIds(input.linkedReportIds ?? [])
    if (input.eventKind !== "cleanup" && linkedReportIds.length > 0) {
      throw AppError.validation({ linkedReportIds: "only cleanup events can link reports" })
    }
    await assertReportsLinkable(linkedReportIds)
    const addressWrite = await resolveEventAddress(input, {
      fromStoredEvent: copyFrom !== undefined,
    })
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

    const host = await resolveHostWrite({
      patch: { ...input, scheduledAt: input.scheduledAt, endsAt: endsAt.toISOString() },
      actorId: organizerUserId,
      cleanupId: null,
      current: null,
    })
    await assertHostEventBudget(organizerUserId)

    const jurisdictionGeoid =
      deps.resolveJurisdictionGeoid !== undefined
        ? await deps.resolveJurisdictionGeoid(input.lat, input.lng)
        : null
    const jurCode =
      deps.resolveJurisdictionCode !== undefined
        ? await deps.resolveJurisdictionCode(jurisdictionGeoid)
        : UNKNOWN_JURCODE

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
    const [linkedReports, slotBoard, media] = await Promise.all([
      hydrateLinkedReports(record.id, record.eventKind),
      hydrateSlots(record.id, organizerUserId),
      eventMediaUrls(record, { gallery: true }),
    ])
    return enrichOne(
      toCleanupDTO(record, standing.eventRole !== null, linkedReports, standing.eventRole, {
        slots: slotBoard,
        myCapabilities: capabilityList(standing),
        ...media,
      }),
      organizerUserId,
    )
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

  return {
    createCleanup(input: CreateCleanupRequest, organizerUserId: string): Promise<CleanupDTO> {
      return createEvent(input, organizerUserId)
    },

    async duplicateCleanup(actorId: string, input: DuplicateCleanupRequest): Promise<CleanupDTO> {
      if (input.endsAt === null) throw AppError.validation({ endsAt: "required" })
      const { record: source } = await requireCapabilityOn(input.id, actorId, "manage_event")
      const organizationId = await resolveDuplicateOrganization(source.organizationId, actorId)
      const now = new Date()
      const scheduledAt = new Date(input.scheduledAt)
      const sourceDurationMs = source.endsAt.getTime() - source.scheduledAt.getTime()
      const endsAt =
        input.endsAt ?? new Date(scheduledAt.getTime() + sourceDurationMs).toISOString()
      const slots = await deps.repo.listSlots(source.id, null)
      const shiftMs = scheduledAt.getTime() - source.scheduledAt.getTime()
      const shifted = (at: Date | null): string | null =>
        at === null ? null : new Date(at.getTime() + shiftMs).toISOString()
      const copy: CreateCleanupRequest = {
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
          slots.length > 0
            ? slots.map((slot) => ({
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
      assertCapability(current, standing, "manage_event")
      if (patch.organizationId !== undefined && patch.organizationId !== current.organizationId) {
        assertCapability(current, standing, "manage_org_link")
      }
      const requesterRole = standing.eventRole
      if (current.status === "cancelled") {
        throw AppError.conflict("This event has been cancelled and can no longer be edited.")
      }
      const hasEnded = deriveCleanupStatus(eventWindowOf(current), Date.now()) === "done"
      if (hasEnded) {
        const frozen =
          patch.title !== undefined ||
          patch.scheduledAt !== undefined ||
          patch.lat !== undefined ||
          patch.lng !== undefined ||
          patch.type !== undefined ||
          patch.eventKind !== undefined
        if (frozen) {
          throw AppError.conflict(
            "An event that has ended can't change its date, title, location or type.",
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

      if (patch.endsAt === null) {
        throw AppError.validation({ endsAt: "an event must have an end time" })
      }
      if (
        hasEnded &&
        patch.endsAt !== undefined &&
        new Date(patch.endsAt).getTime() !== current.endsAt.getTime()
      ) {
        throw AppError.conflict("An event that has ended can't change its end time.")
      }
      const effectiveWindow: EventWindow = {
        status: current.status,
        scheduledAt:
          patch.scheduledAt !== undefined ? new Date(patch.scheduledAt) : current.scheduledAt,
        endsAt: patch.endsAt !== undefined ? new Date(patch.endsAt) : current.endsAt,
      }
      const windowMoved =
        effectiveWindow.scheduledAt.getTime() !== current.scheduledAt.getTime() ||
        (effectiveWindow.endsAt?.getTime() ?? null) !== (current.endsAt?.getTime() ?? null)

      if (patch.slots !== undefined && hasEnded) {
        throw AppError.validation({ slots: "Slots can't be changed after an event has ended." })
      }
      if (patch.slots !== undefined && patch.slots.length === 0) {
        throw AppError.validation({ slots: EVENT_NEEDS_A_SLOT_MESSAGE })
      }
      const desiredSlots =
        patch.slots !== undefined
          ? toDesiredSlots(patch.slots, { keepIds: true }, effectiveWindow)
          : null

      if (desiredSlots === null && windowMoved) {
        const timed = (await deps.repo.listSlots(id, null)).filter(
          (slot): slot is EventSlotView & { startsAt: Date; endsAt: Date } =>
            slot.startsAt !== null && slot.endsAt !== null,
        )
        const outside = timed.some(
          (slot) =>
            effectiveWindow.endsAt === null ||
            slot.startsAt < effectiveWindow.scheduledAt ||
            slot.endsAt > effectiveWindow.endsAt,
        )
        if (outside) {
          throw AppError.validation({
            scheduledAt:
              "timed slots would fall outside the new start and end; update the slots in the same save",
          })
        }
      }

      if (desiredSlots !== null) {
        const existingSlotIds = new Set((await deps.repo.listSlots(id, null)).map((s) => s.id))
        for (const slot of desiredSlots) {
          if (slot.id !== undefined && !existingSlotIds.has(slot.id)) {
            throw AppError.validation({ slots: `unknown slot: ${slot.id}` })
          }
        }
      }

      const addressPatch = eventAddressPatch(patch)

      const movedTo =
        patch.lat !== undefined && patch.lng !== undefined
          ? { lat: patch.lat, lng: patch.lng }
          : null
      const reresolvedGeoid =
        movedTo !== null && deps.resolveJurisdictionGeoid !== undefined
          ? await deps.resolveJurisdictionGeoid(movedTo.lat, movedTo.lng)
          : undefined

      const host = await resolveHostWrite({
        patch,
        actorId: requesterUserId,
        cleanupId: id,
        current,
      })

      const scalarPatch: UpdateCleanupPatch = {
        ...host,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.eventKind !== undefined ? { eventKind: patch.eventKind } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.scheduledAt !== undefined ? { scheduledAt: new Date(patch.scheduledAt) } : {}),
        ...(patch.lat !== undefined ? { lat: patch.lat } : {}),
        ...(patch.lng !== undefined ? { lng: patch.lng } : {}),
        ...addressPatch,
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
      if (slotDiff !== null) {
        await notifySlotChanges(record, slotDiff)
      }
      if (
        deriveCleanupStatus(eventWindowOf(record), Date.now()) !== "done" &&
        guestVisibleChange(current, patch)
      ) {
        await dispatchGuestUpdateFanout(record.id)
      }
      const [linkedReports, slotBoard, media] = await Promise.all([
        hydrateLinkedReports(id, record.eventKind),
        hydrateSlots(id, requesterUserId),
        eventMediaUrls(record, { gallery: true }),
      ])
      return enrichOne(
        toCleanupDTO(record, standing.eventRole !== null, linkedReports, requesterRole, {
          slots: slotBoard,
          myCapabilities: capabilityList(standing),
          ...media,
        }),
        requesterUserId,
      )
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
      if (outcome === "cancelled") await dispatchCancelFanout(record, cleanReason, requesterUserId)
      const [linkedReports, slotBoard, media] = await Promise.all([
        hydrateLinkedReports(id, record.eventKind),
        hydrateSlots(id, requesterUserId),
        eventMediaUrls(record, { gallery: true }),
      ])
      return enrichOne(
        toCleanupDTO(record, true, linkedReports, standing.eventRole ?? "organizer", {
          slots: slotBoard,
          myCapabilities: capabilityList(standing),
          ...media,
        }),
        requesterUserId,
      )
    },

    async completeCleanup(
      id: string,
      note: string | null,
      requesterUserId: string,
      userAgent: string | null = null,
    ): Promise<CleanupDTO> {
      const { standing } = await requireCapabilityOn(id, requesterUserId, "manage_event")
      const requesterRole = standing.eventRole
      const trimmed = note?.trim()
      assertNoSlur(trimmed && trimmed.length > 0 ? trimmed : null, "note")
      deps.logger?.info({ cleanupId: id, userAgent }, "cleanup.complete.deprecated")

      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()
      const [linkedReports, slotBoard, media] = await Promise.all([
        hydrateLinkedReports(id, record.eventKind),
        hydrateSlots(id, requesterUserId),
        eventMediaUrls(record, { gallery: true }),
      ])
      return enrichOne(
        toCleanupDTO(record, standing.eventRole !== null, linkedReports, requesterRole, {
          slots: slotBoard,
          myCapabilities: capabilityList(standing),
          ...media,
        }),
        requesterUserId,
      )
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
      const ids = records.map((r) => r.id)

      const [standingsById, linkedByCleanup, slotCounts, coverUrls] = await Promise.all([
        standingsOf(ids, viewer.userId),
        hydrateLinkedReportsForMany(records),
        deps.repo.slotCountsFor(ids),
        hydrateCoverUrls(records),
      ])
      const items = records.map((record) => {
        const standing = standingsById.get(record.id) ?? NO_HOST_STANDING
        return toCleanupDTO(
          record,
          hasHostStanding(standing),
          linkedByCleanup.get(record.id) ?? [],
          standing.eventRole,
          {
            slotCount: slotCounts.get(record.id) ?? 0,
            myCapabilities: capabilityList(standing),
            coverUrl: coverUrls.get(record.id) ?? null,
          },
        )
      })
      return { items: await enrichDTOs(items, viewer.userId), nextCursor }
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
      const ids = records.map((r) => r.id)
      const presign = deps.presignEventMedia
      const [standingsById, linkedByCleanup, slotCounts, coverUrls, organizationLogoUrl] =
        await Promise.all([
          standingsOf(ids, viewer.userId),
          hydrateLinkedReportsForMany(records),
          deps.repo.slotCountsFor(ids),
          hydrateCoverUrls(records),
          host.organization.logoKey === null || presign === undefined
            ? Promise.resolve(null)
            : presign(host.organization.logoKey, { forceSigned: false }),
        ])
      const items = records.map((record) => {
        const standing = standingsById.get(record.id) ?? NO_HOST_STANDING
        return toCleanupDTO(
          record,
          hasHostStanding(standing),
          linkedByCleanup.get(record.id) ?? [],
          standing.eventRole,
          {
            slotCount: slotCounts.get(record.id) ?? 0,
            myCapabilities: capabilityList(standing),
            coverUrl: coverUrls.get(record.id) ?? null,
            organizationLogoUrl,
          },
        )
      })
      return { items: await enrichDTOs(items, viewer.userId), nextCursor }
    },

    async getCleanup(id: string, viewer: CleanupViewer): Promise<CleanupDTO> {
      const record = isUuid(id)
        ? await deps.repo.findCleanupById(id, null)
        : ((await deps.repo.findCleanupByReferenceCode(id)) ??
          (await deps.repo.findCleanupByPageSlug(id)))
      if (!record) notFoundCleanup()
      const standing = await standingOf(record.id, viewer.userId)
      assertVisible(record, standing)
      const [linkedReports, slotBoard, media] = await Promise.all([
        hydrateLinkedReports(record.id, record.eventKind),
        hydrateSlots(record.id, viewer.userId),
        eventMediaUrls(record, { gallery: true }),
      ])
      return enrichOne(
        toCleanupDTO(record, hasHostStanding(standing), linkedReports, standing.eventRole, {
          slots: slotBoard,
          myCapabilities: capabilityList(standing),
          ...media,
        }),
        viewer.userId,
      )
    },

    async joinCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }> {
      await assertMembershipFlipBudget(id, userId)
      const outcome = await deps.repo.joinCleanupTx(id, userId, newSignupSeat())
      if (outcome === "not_found") notFoundCleanup()
      if (outcome === "banned") {
        throw AppError.forbidden("A host removed you from this event, so you can't rejoin it.")
      }
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
        const seen = await counters.incr(
          `host:rosterAudit:${id}:${viewer.userId}`,
          ROSTER_AUDIT_DEDUPE_WINDOW_SEC,
        )
        if (seen === 1) {
          await audit.record({
            actorId: viewer.userId,
            action: "event.roster_viewed",
            target: `cleanup:${id}`,
            meta: { returned: views.length },
          })
        }
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

      await audit.record({
        actorId,
        action: "event.team_role_changed",
        target: `cleanup:${id}`,
        meta: { targetUserId, from: targetRole, to: role },
      })
      await notifyRoleChange(targetUserId, role === "member" ? "demoted" : "promoted", {
        id: record.id,
        title: record.title,
      })
      return { ok: true }
    },

    async removeMember(
      id: string,
      actorId: string,
      targetUserId: string,
    ): Promise<RemoveMemberResponse> {
      const { record, standing } = await requireCapabilityOn(id, actorId, "manage_event")
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
      if (targetRole !== "member" && !can(standing, "manage_team")) {
        throw AppError.forbidden(hostForbiddenCopy("manage_team"))
      }

      const outcome = await deps.repo.removeMember(id, targetUserId, actorId)
      if (outcome.kind === "not_found") notFoundCleanup()
      if (outcome.kind === "closed") throw AppError.conflict(EVENT_CLOSED_MESSAGE)
      if (outcome.kind === "not_member") {
        throw AppError.notFound("That person isn't attending this event.")
      }

      await deps.insightsInvalidator?.bumpInsightsGeneration(id)

      await audit.record({
        actorId,
        action: "event.attendee_removed",
        target: `cleanup:${id}`,
        meta: { targetUserId, role: targetRole },
      })
      await notifyRoleChange(targetUserId, "removed", { id: record.id, title: record.title })
      return { ok: true, going: outcome.going }
    },

    async claimEventSlot(id: string, userId: string, slotId: string | null): Promise<CleanupDTO> {
      const flips = await counters.incr(`cleanup:slot:${id}:${userId}`, SLOT_FLIP_WINDOW_SEC)
      if (flips > SLOT_FLIPS_PER_EVENT_PER_WINDOW) {
        throw AppError.rateLimited(
          "You've changed your slot too many times recently. Please try again later.",
        )
      }

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
      if (outcome.kind === "banned") {
        throw AppError.forbidden("A host removed you from this event, so you can't rejoin it.")
      }
      if (outcome.kind === "closed") throw AppError.conflict(EVENT_CLOSED_MESSAGE)
      if (outcome.kind === "ended") throw eventEndedError()
      if (outcome.kind === "full") throw AppError.conflict("That slot is already full.")

      await deps.insightsInvalidator?.bumpInsightsGeneration(id)

      const updated = await deps.repo.findCleanupById(id, null)
      if (!updated) notFoundCleanup()
      const nextStanding = await standingOf(id, userId)
      const [linkedReports, slotBoard, media] = await Promise.all([
        hydrateLinkedReports(id, updated.eventKind),
        hydrateSlots(id, userId),
        eventMediaUrls(updated, { gallery: true }),
      ])
      return enrichOne(
        toCleanupDTO(
          updated,
          hasHostStanding(nextStanding),
          linkedReports,
          nextStanding.eventRole,
          {
            slots: slotBoard,
            myCapabilities: capabilityList(nextStanding),
            ...media,
          },
        ),
        userId,
      )
    },

    async requestResources(input: {
      cleanupId: string
      message: string
      actorId: string
    }): Promise<RequestEventResourcesResponse> {
      if (deps.outboundMail === undefined) {
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
      await notifyCancellation({ id: record.id, title: record.title }, job.reason, job.actorId)
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
  if (patch.lat !== undefined && patch.lat !== current.lat) return true
  if (patch.lng !== undefined && patch.lng !== current.lng) return true
  return false
}

function resourceRequestNote(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim()
  const preview = collapsed.length > 140 ? `${collapsed.slice(0, 140)}…` : collapsed
  return preview.length > 0 ? `Resources requested — ${preview}` : "Resources requested"
}
