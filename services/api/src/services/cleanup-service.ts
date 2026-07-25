
import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import { UNKNOWN_JURCODE } from "../db/reference-code.js"
import { assertNoSlur } from "../abuse/slur-filter.js"
import { InMemoryCounterStore, type CounterStore } from "../abuse/counter-store.js"
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

/**
 * M20 — resource-request anti-spam.
 *
 * This WAS an in-process `Map` keyed on `${cleanupId}:${actorId}`, which bounded nothing that mattered:
 * every new throwaway event minted a fresh cooldown key, the Map was per-instance (so N API pods meant
 * N times the budget), and a deploy cleared it outright. A verified host looped
 * create-event -> request-resources and relayed ~150 branded emails/minute into municipal inboxes,
 * DKIM-signed by civfix's own authenticated SMTP domain.
 *
 * The budget is now shared (Redis) and keyed on the two things an attacker cannot mint for free:
 *   - the ACTOR (a verified-host account), capped per day, and
 *   - the JURISDICTION GEOID (the receiving municipal inbox), capped per hour — this is the one that
 *     protects a city from being flooded by a set of colluding or compromised host accounts.
 * `cleanupId` is deliberately NOT part of any key: it was the whole bypass.
 *
 * Both windows are anchored at their first hit (CounterStore applies the TTL only on creation), so a
 * host that trips the daily cap waits out the remainder of that day's window rather than a rolling one.
 */
export const RESOURCE_REQUEST_PER_HOST_PER_DAY = 10
const RESOURCE_REQUEST_HOST_WINDOW_SEC = 24 * 60 * 60

export const RESOURCE_REQUEST_PER_JURISDICTION_PER_HOUR = 30
const RESOURCE_REQUEST_JURISDICTION_WINDOW_SEC = 60 * 60

/**
 * M18 — promote/demote notification bombing.
 *
 * `setMemberRole` short-circuits when the target already holds the requested role, but there are
 * exactly two legal values, so alternating cohost/member defeats that idempotency check completely and
 * every flip fires a real lock-screen push. Combined with the (now added) per-route rate limit this
 * caps how often ONE victim can be rung about ONE event no matter how many IPs or sessions the attacker
 * rotates through — the route limit alone is per-IP and therefore evadable.
 *
 * Counted per (cleanup, target), not per actor: the harm is measured at the receiver.
 */
export const ROLE_CHANGES_PER_TARGET_PER_WINDOW = 6
const ROLE_CHANGE_WINDOW_SEC = 60 * 60

/**
 * L23 — `bring` is an unbounded array in the frozen shared wire schema (no `.max()`), capped only by the
 * 256 KB body limit, which admits thousands of entries that are then rendered to every attendee. Clamped
 * here exactly as MAX_LINKED_REPORTS / clampLinkIds already clamps `linkedReportIds`. FOLLOW-UP: the
 * real fix is `.max(MAX_BRING_ITEMS)` on CreateCleanupRequestSchema/UpdateCleanupRequestSchema in
 * @civfix/shared, which this repo cannot edit.
 */
export const MAX_BRING_ITEMS = 30

/**
 * Fan-out bound for the cancellation bell (L24). The old raw SQL was a single set-based INSERT with no
 * cap; routing through NotificationService means one pipeline call per recipient, so the roster read is
 * bounded like every other member fan-out. Matches EVENT_HOURS_MEMBER_CAP — an event with more
 * attendees than this has bigger problems than a truncated bell.
 */
const CANCEL_FANOUT_MEMBER_CAP = 2000

/**
 * Degraded fallback for a service constructed with no CounterStore (offline tests, USE_FAKE_* dev). It
 * carries the SAME weaknesses the old code had in production — per-process, cleared on restart — which
 * is precisely why production MUST wire the Redis-backed store (see cleanups.routes.ts). Keeping a
 * fallback rather than failing open means the limits are still exercised by the unit suite.
 */
const fallbackCounters = new InMemoryCounterStore()

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
  // M18/M20: the SHARED (Redis-backed in production) counter behind the resource-request budget and the
  // role-change cooldown. Both were in-process before, which meant per-pod budgets that a deploy reset.
  // Optional so an offline test can run without Redis — see fallbackCounters above for what that costs.
  counters?: CounterStore
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
  const counters = deps.counters ?? fallbackCounters

  /**
   * M19 — the slur filter reached reports, profiles and chat but NOT a single event field, even though
   * events are the platform's most public user-generated surface: they render on the anonymously
   * readable map behind a 60s public cache, and the cancellation reason is fanned out verbatim to every
   * attendee's notification. Mirrors report-service.createReport's title/description checks; each field
   * is named so the 422 tells the host exactly which one to fix.
   */
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

  // L23: clamp the unbounded shared `bring` array (see MAX_BRING_ITEMS).
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

  /**
   * L24 — the event-cancellation fan-out.
   *
   * This used to be a raw `INSERT INTO notifications ... SELECT FROM cleanup_members` inside
   * cancelCleanupTx, the ONLY bell in the product that bypassed NotificationService: it ignored the
   * recipient's push preferences and quiet hours, never localized (hardcoded English), and never
   * emitted the user-channel signal that refreshes an open client's bell badge. It now rides the same
   * pipeline as every other notification.
   *
   * Best-effort, exactly like notifyRoleChange: the cancellation itself is already committed, so a
   * notification failure is logged and suppressed rather than failing the mutation the host just made.
   *
   * FOLLOW-UP (not applied here to avoid colliding with the notifications workstream): the title/body
   * are passed as literal strings because there is no `notification.cleanup_cancelled.*` entry in
   * src/i18n/messages/en.ts. Adding those keys and switching to titleKey/bodyKey/vars completes the
   * localization half; prefs, quiet hours and the signal are already fixed by this change.
   */
  async function notifyCancellation(
    cleanup: { id: string; title: string },
    body: string,
    actorId: string,
  ): Promise<void> {
    if (deps.notifier === undefined) return
    try {
      const memberIds = await deps.repo.listMemberIds(cleanup.id, CANCEL_FANOUT_MEMBER_CAP)
      for (const userId of memberIds) {
        if (userId === actorId) continue
        await deps.notifier.createNotification(userId, {
          type: "cleanup_cancelled",
          title: "Event cancelled",
          body,
          link: `/cleanups/${cleanup.id}`,
        })
      }
    } catch (err) {
      deps.logger?.warn(
        { err, cleanupId: cleanup.id },
        "cleanup_cancelled notification fan-out failed (suppressed)",
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
      assertEventTextClean(input)
      clampBring(input.bring)
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
      assertEventTextClean(patch)
      clampBring(patch.bring)
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
      // M19: the raw 500-char reason is interpolated into a body pushed to EVERY attendee's lock
      // screen and written into the public event timeline, so it gets the same gate as report text.
      assertNoSlur(cleanReason, "reason")
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
      await notifyCancellation(record, body, requesterUserId)
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
      // M17: the join is no longer unconditional — a host's removal writes a cleanup_bans row and the
      // repo refuses to re-create the membership while it exists. 403 (not 404): the event is public
      // and listed on the map, so its existence is not the secret; the removal is the answer.
      const outcome = await deps.repo.joinCleanupTx(id, userId)
      if (outcome === "not_found") notFoundCleanup()
      if (outcome === "banned") {
        throw AppError.forbidden("A host removed you from this event, so you can't rejoin it.")
      }
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
        // M17 (the unban path): a removed attendee has NO membership row but DOES have a ban row.
        // Re-asserting the plain 'member' role on such a person is the organizer's "let them back in"
        // gesture, so it lifts the ban. Reusing this endpoint is deliberate — the route table lives in
        // the frozen @civfix/shared registry, so a dedicated DELETE /bans endpoint cannot be added from
        // this repo. It fires no bell (the person was never notified of the ban itself either) and it
        // does NOT re-join them: they RSVP again themselves, which is the normal consent flow.
        if (role === "member" && (await deps.repo.isBanned(id, targetUserId))) {
          await deps.repo.unbanMember(id, targetUserId)
          return { ok: true }
        }
        throw AppError.notFound("That person isn't attending this event.")
      }
      // Idempotent: setting the role they already have is a no-op success (and no bell).
      if (targetRole === role) return { ok: true }

      // M18: there are exactly two legal roles, so alternating them defeats the idempotency check
      // above and turns this endpoint into a lock-screen push cannon aimed at anyone who joined a
      // public event. The cooldown is counted per (event, TARGET) in the shared store, so it survives
      // the attacker rotating IPs (which evades the per-route limiter) and pods.
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

      // M17: removal is the membership delete AND a cleanup_bans row, written in one transaction.
      // Deleting the membership drops the target from the event group chat (the same row gates
      // isMember); the ban is what stops them re-joining a second later via the self-service join. The
      // organizer lifts it by re-asserting the 'member' role on them (see setMemberRole above).
      //
      // KNOWN GAP (ws/** is out of scope for this change): an ALREADY-OPEN WebSocket is never
      // re-authorized, so the removed user keeps reading the room in real time until they reconnect.
      // Closing it needs a revocation publish on the room channel from ws/socket-lifecycle.ts — see the
      // handover notes accompanying this fix.
      const { removed, going } = await deps.repo.removeMember(id, targetUserId, actorId)
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

      // M20: the budget is charged AFTER every authorization gate (so a failed 403 costs nothing) and
      // BEFORE the send. Both counters are incremented on every attempt — an attempt that trips the
      // jurisdiction cap still consumes the host's daily allowance, which is the correct direction: it
      // makes probing for a city's remaining headroom expensive.
      const hostSends = await counters.incr(
        `cleanup:res-req:host:${input.actorId}`,
        RESOURCE_REQUEST_HOST_WINDOW_SEC,
      )
      // A null geoid never reaches here (resolveJurisdictionContact returned non-null above), but the
      // bucket key falls back explicitly rather than interpolating "null" by accident.
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
  }
}

function resourceRequestNote(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim()
  const preview = collapsed.length > 140 ? `${collapsed.slice(0, 140)}…` : collapsed
  return preview.length > 0 ? `Resources requested — ${preview}` : "Resources requested"
}
