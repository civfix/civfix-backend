
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
 * L23 — the `bring` cap. This WAS a local `= 30` literal alongside a FOLLOW-UP note asking for
 * `.max(MAX_BRING_ITEMS)` on CreateCleanupRequestSchema/UpdateCleanupRequestSchema; the shared schemas
 * now carry it, so the literal is gone and the cap is re-exported from the contract. Two sources of
 * truth for one cap is how the wire schema and the service clamp drift apart by a deploy.
 * Re-exported (rather than merely imported) because test/unit/cleanup-service.test.ts and any other
 * consumer import it from THIS module.
 */
export { MAX_BRING_ITEMS }

/**
 * P9 — the slot-set cap, RE-EXPORTED from the contract for exactly the reason MAX_BRING_ITEMS is: the
 * wire schema (`CreateCleanupRequestSchema.slots.max(MAX_EVENT_SLOTS)`) and the service clamp must be
 * the same number by construction, and the slot EDITOR enforces it client-side too. A second local
 * literal is how those three drift apart by a deploy.
 *
 * The service clamp is not redundant with the schema: a service-level caller (and the unit suite) never
 * goes through the wire schema, and B26 requires the refusal to be deterministic and named.
 */
export { MAX_EVENT_SLOTS }

/**
 * B29c — slot flapping.
 *
 * The route-level 30/min limit is per-IP and therefore evadable by rotating exits; this is the inner,
 * non-evadable layer, counted per (event, user) in the SHARED store — the same two-layer shape M18's
 * role-change cooldown established. Flapping is not merely noisy: every flip takes a `FOR UPDATE` on a
 * contended slot row, so a loop can stall every other claimant on a popular event.
 */
export const SLOT_FLIPS_PER_EVENT_PER_WINDOW = 20
const SLOT_FLIP_WINDOW_SEC = 60 * 60

/**
 * Fan-out bound for the cancellation bell (L24). The old raw SQL was a single set-based INSERT with no
 * cap; routing through NotificationService means one pipeline call per recipient, so the roster read is
 * bounded like every other member fan-out. Matches EVENT_HOURS_MEMBER_CAP — an event with more
 * attendees than this has bigger problems than a truncated bell.
 */
const CANCEL_FANOUT_MEMBER_CAP = 2000

/**
 * Concurrency for that fan-out. The bell used to be awaited one recipient at a time on the request
 * path, so cancelling a well-attended event took CANCEL_FANOUT_MEMBER_CAP sequential pipeline calls
 * (each an insert + a prefs read + a push) before the host got their response. Bounded rather than
 * unbounded for the same reason PRESIGN_CONCURRENCY is: a 2000-wide Promise.all would open 2000
 * concurrent DB/push operations off one HTTP request.
 */
const CANCEL_FANOUT_CONCURRENCY = 8

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
  // B12: a HOST (organizer OR cohost, B13) marks their own event completed — the state logEventHours
  // requires, which until now only an OPERATOR could reach. Returns the refreshed DTO, symmetric with
  // cancelCleanup so the client's cache update is identical. Forward-only (B17): there is no un-complete.
  completeCleanup(id: string, note: string | null, requesterUserId: string): Promise<CleanupDTO>
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
  // P9 (B27/B28): PUT the viewer's slot on this event. `slotId` non-null claims (or MOVES, atomically);
  // `slotId: null` releases. One endpoint, not a claim/release pair — the v1 rule is exactly one slot
  // per person per event, so "my slot on this event" is a singular resource and a PUT of its value is
  // the honest shape (a release+claim pair could release, then find the target full, leaving the user
  // with nothing). Returns the refreshed DETAIL DTO, so the client needs no refetch.
  claimEventSlot(id: string, userId: string, slotId: string | null): Promise<CleanupDTO>
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
   * pipeline as every other notification — including the LOCALIZATION half: the title/body travel as
   * `notification.cleanup_cancelled.*` keys + a `{{reason}}` var, so the pipeline renders them in the
   * recipient's own locale exactly like the cleanup_role bells above (a literal English title/body here
   * would be English on every lock screen no matter what `users.locale` says).
   *
   * Best-effort, exactly like notifyRoleChange: the cancellation itself is already committed, so a
   * notification failure is logged and suppressed rather than failing the mutation the host just made.
   * Best-effort PER RECIPIENT, which the L24 rewrite was not: one try/catch wrapped the whole sequential
   * loop, so a single bad prefs row or push-adapter error abandoned every remaining attendee silently.
   * Each recipient now fails on its own and the rest still get their bell.
   *
   * Called ONLY on a fresh upcoming->cancelled transition (see cancelCleanup): re-cancelling an
   * already-cancelled event must not re-ring 2000 lock screens, which is the same bell-bombing class
   * M18's role-flip cooldown exists for.
   *
   * `reason` is the host's already-trimmed, slur-gated cancellation reason or null when they gave none —
   * the RAW reason, not the composed sentence: the wrapper copy is the catalog's job, and a null reason
   * selects the reason-less body key rather than rendering a dangling "Reason:".
   */
  async function notifyCancellation(
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

  /**
   * B26 — everything the slot payload must survive BEFORE a single row is touched, mirroring
   * clampLinkIds / clampBring. Returns the repo-shaped desired set (array position becomes the default
   * sort_order, because the host's list order IS the board order).
   *
   * `status` is the event's CURRENT lifecycle state, or null on create.
   *
   * Deliberately NOT gated on eventKind: unlike linkedReportIds (cleanup-only), slots are legal on BOTH
   * kinds — an `other_volunteer` event (a food-bank shift, a phone bank) is precisely the kind with
   * named roles.
   */
  function toDesiredSlots(
    slots: EventSlotInput[],
    status: CleanupStatus | null,
    opts: { keepIds: boolean },
  ): DesiredSlot[] {
    // Slot reconciliation is refused on a done/cancelled event: deleting or renaming a slot after
    // completion rewrites the roster the credited hours were attested against. (The REST of
    // updateCleanup stays ungated on status, exactly as it is today.)
    if (status === "done" || status === "cancelled") {
      throw AppError.validation({ slots: "slots can't be changed after an event is completed" })
    }
    if (slots.length > MAX_EVENT_SLOTS) {
      throw AppError.validation({ slots: `at most ${MAX_EVENT_SLOTS} slots may be listed` })
    }
    // Case-insensitively duplicate titles are rejected HERE, deterministically, rather than being left
    // to cleanup_slots_cleanup_title_uidx — a raw constraint violation would surface as a 500 and name
    // nothing the host can act on.
    const seen = new Set<string>()
    for (const slot of slots) {
      const key = slot.title.trim().toLowerCase()
      if (seen.has(key)) {
        throw AppError.validation({ slots: `duplicate slot title: ${slot.title}` })
      }
      seen.add(key)
      // gotcha #14: slot text is host-authored free text rendered to every attendee, exactly like
      // title / bring / reason — so it gets exactly their gate.
      assertNoSlur(slot.title, "slots")
      assertNoSlur(slot.description ?? null, "slots")
    }
    return slots.map((slot, index) => ({
      // On CREATE an `id` is meaningless — there is no existing slot to edit — so it is dropped and
      // every entry inserts. On UPDATE it is kept, and the repo hard-422s an id that belongs to a
      // different event rather than quietly re-parenting it (B23).
      ...(opts.keepIds && slot.id !== undefined ? { id: slot.id } : {}),
      title: slot.title,
      description: slot.description ?? null,
      capacity: slot.capacity ?? null,
      sortOrder: slot.sortOrder ?? index,
    }))
  }

  /** The DETAIL-shaped slot board for one cleanup (B29a). */
  async function hydrateSlots(cleanupId: string, viewerId: string | null): Promise<EventSlotDTO[]> {
    const views = await deps.repo.listSlots(cleanupId, viewerId)
    return views.map(toEventSlotDTO)
  }

  /**
   * B34 — "your claimed slot was removed".
   *
   * Fired from updateCleanup off reconcileSlots' removed[].claimantUserIds (the actor is already
   * excluded by the repo). Same fan-out bound, concurrency and best-effort-PER-RECIPIENT shape as the
   * cancellation notifier: the edit is already committed, so a bell failure is logged and suppressed,
   * and one bad prefs row must not abandon the remaining claimants.
   *
   * There is deliberately NO counterpart bell to the HOST when someone CLAIMS a slot (B35): a popular
   * event would ring the organizer once per RSVP for information they can see on their own roster, and
   * coordination already has the event group chat.
   */
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
      // B22/B26: validated (cap, duplicate titles, slur gate) BEFORE anything is written, then inserted
      // inside the create transaction itself. A brand-new event is 'upcoming', so the done/cancelled
      // refusal cannot fire here — `null` says "no current status to refuse".
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

      // B23: `slots` is the FULL desired set. Omitting the key leaves the board untouched; sending []
      // deletes every slot. Validated (B26) against the event's CURRENT status before any write — the
      // rest of the patch stays ungated on status, as it is today.
      const desiredSlots =
        patch.slots !== undefined
          ? toDesiredSlots(patch.slots, current.status, { keepIds: true })
          : null

      // B23's foreign/unknown-id refusal fires inside reconcileSlots' transaction — which is opened
      // AFTER the scalar patch below has already committed. A stale slot id (two co-hosts editing at
      // once, or the same host in two tabs) would therefore 422 a request whose title, scheduledAt,
      // location and jurisdiction re-resolve had ALREADY been written: an error response for a PATCH
      // that half-applied. The ids are checked against the event's CURRENT board here, before any
      // write, so the whole request is all-or-nothing and not merely the slot board. The
      // in-transaction check STAYS as the race backstop (a slot deleted between this read and the
      // reconcile) and as the guarantee for any other caller of the repo.
      if (desiredSlots !== null) {
        const existingSlotIds = new Set((await deps.repo.listSlots(id, null)).map((s) => s.id))
        for (const slot of desiredSlots) {
          if (slot.id !== undefined && !existingSlotIds.has(slot.id)) {
            throw AppError.validation({ slots: `unknown slot: ${slot.id}` })
          }
        }
      }

      // A moved event belongs to a DIFFERENT government. cleanups.jurisdiction_geoid routes
      // requestResources' municipal email (resolveJurisdictionContact) and buckets the event's
      // volunteer-hours rollup, so it is re-resolved with the geometry instead of being left pointing at
      // the city the event was created in. The repo rebuilds geom only when BOTH coordinates are present
      // (UpdateCleanupPatch's contract), so that same pair gates the re-resolve.
      //
      // reference_code is deliberately NOT re-issued: it is the event's immutable public identity, and
      // its JURCODE segment stays that of the creating jurisdiction by design (D1).
      const movedTo =
        patch.lat !== undefined && patch.lng !== undefined
          ? { lat: patch.lat, lng: patch.lng }
          : null
      // undefined = don't touch the stored geoid; null = the new position is outside coverage (which is
      // a real answer, and makes requestResources correctly report the event as not routable).
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
      // B24/B34: deleting a claimed slot drops its claimants silently — legitimate, and the bell is the
      // mitigation. Fired AFTER the reconcile commits, best-effort, and only for slots that actually
      // went away (an edit that renames or adds rings nobody).
      if (slotDiff !== null && slotDiff.removed.length > 0) {
        await notifySlotRemoved(record, slotDiff.removed)
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
      // M19: the raw 500-char reason is interpolated into a body pushed to EVERY attendee's lock
      // screen and written into the public event timeline, so it gets the same gate as report text.
      assertNoSlur(cleanReason, "reason")
      const note = cleanReason ? `Event cancelled: ${cleanReason}` : "Event cancelled"
      // The `body` the repo takes is a vestige of the pre-L24 in-transaction bell: nothing persists it
      // any more (the Drizzle tx writes only the status flip + the `note` timeline row), and the bell
      // itself is now rendered per-recipient from the notification catalog in notifyCancellation. Kept as
      // the English composition it always was so the repo contract is unchanged — FOLLOW-UP: drop the
      // field from CleanupRepository.cancelCleanupTx + both implementations + the test fake together.
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
      // B18: cancel is not a back door out of B17's forward-only completion. A cancelled event that
      // still carries credited volunteer_hours rows is a state nothing downstream can interpret, so a
      // completed event refuses the transition outright (409) instead of silently no-op'ing.
      if (outcome === "already_completed") {
        throw AppError.conflict("A completed event can't be cancelled.")
      }

      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()
      // Cancelling is idempotent at the HTTP layer (same 200 + DTO either way), but the fan-out is not
      // idempotent at the receiver: the repo reports whether THIS call made the transition, and only a
      // fresh one rings the roster. Without this an organizer (or a retrying client) could loop
      // /cancel and push every attendee's lock screen on each pass.
      if (outcome === "cancelled") await notifyCancellation(record, cleanReason, requesterUserId)
      const [linkedReports, slotBoard] = await Promise.all([
        hydrateLinkedReports(id, record.eventKind),
        hydrateSlots(id, requesterUserId),
      ])
      // The canceller passed the organizer-only gate above, so their role is organizer by definition.
      return toCleanupDTO(record, true, linkedReports, "organizer", { slots: slotBoard })
    },

    /**
     * B12 — the host closes their own event.
     *
     * Until this existed only an operator could move an event to 'done' (the admin event-status route),
     * and 'done' is what logEventHours hard-requires — so a host could never credit a single attendee
     * without asking support. The gate is organizer OR COHOST (B13), unlike cancel's organizer-only:
     * cancel is destructive and rings every attendee's lock screen, completion is forward and silent
     * (B19 — no bell; the actionable moment is hours_logged), and the cohost is exactly the person who
     * then logs the hours. Same gate as updateCleanup, so the host mental model stays "hosts edit and
     * close; the organizer cancels".
     *
     * Everything else — the status matrix, the time gate, the timeline row — happens in ONE transaction
     * against the LOCKED row (B15/B16), because a concurrent updateCleanup can move scheduled_at and a
     * concurrent completion must not write two timeline rows.
     */
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
      // M19/gotcha #14: every host-authored free text gets the same gate. This one lands in the public
      // event timeline, so it is held to exactly the standard the cancellation reason is.
      assertNoSlur(cleanNote, "note")
      // The SERVICE composes the copy and the repo only persists — the layer split cancelCleanupTx
      // already documents.
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
        // B14: hours are a falsifiable public record. Without a time anchor a host could date an event
        // next year, mark it done, and credit hours for something that has not happened. scheduled_at is
        // the only real-world anchor on the row (there is no endsAt column), so completion opens at the
        // event's START — early enough to close out a short event the moment it wraps.
        throw AppError.conflict(
          "This event hasn't started yet — you can mark it complete once it begins.",
        )
      }
      // "already_completed" falls through: a repeat call is an idempotent 200 + DTO (no second timeline
      // row was written, and there is no bell to suppress).

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
      // B29a: a feed card does not render a slot board, so the list read pays for ONE aggregate instead
      // of a per-page join, and `slots` stays empty. `slotCount` is what removes the "[] means no slots
      // or not hydrated?" ambiguity for the card.
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
        // The resolve-either path means the URL id may be a reference code, so the hydration keys off
        // the RESOLVED record id, never the raw path segment.
        hydrateSlots(record.id, viewer.userId),
      ])
      return toCleanupDTO(record, role !== null, linkedReports, role, { slots: slotBoard })
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

    /**
     * P9 — the attendee picks, moves or drops a shift (B27/B28).
     *
     * All the concurrency lives in the repository transaction; this method owns the budget, the outcome
     * -> HTTP mapping, and the refreshed DTO. Note what is NOT here: a membership gate. Claiming
     * auto-RSVPs (B28b) because picking a shift IS an RSVP, and making a non-member fail with
     * `not_member` and retry would be both worse UX and a worse race. The ban probe runs first inside
     * the transaction, so a removed attendee cannot re-enter through the slot door.
     */
    async claimEventSlot(
      id: string,
      userId: string,
      slotId: string | null,
    ): Promise<CleanupDTO> {
      // B29c: charged on every attempt, BEFORE the transaction — the point is to keep a flapper off the
      // contended slot row, so a refused attempt must still cost. Counted per (event, user) in the
      // shared store so rotating IPs (which evades the per-route limiter) buys nothing.
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
        // 404 and not 422: the slot is addressed as a sub-resource of the event, and "no such slot on
        // this event" is exactly the not-found answer. It is also the answer for a slotId belonging to
        // ANOTHER event, which the composite FK makes structurally impossible to claim anyway.
        throw AppError.notFound("That slot no longer exists.")
      }
      // Reuses joinCleanup's copy verbatim — same situation, same sentence.
      if (outcome.kind === "banned") {
        throw AppError.forbidden("A host removed you from this event, so you can't rejoin it.")
      }
      if (outcome.kind === "closed") throw AppError.conflict("This event is closed.")
      if (outcome.kind === "full") throw AppError.conflict("That slot is already full.")

      const record = await deps.repo.findCleanupById(id, null)
      if (!record) notFoundCleanup()
      // The response is the DETAIL DTO (C5): it already carries `slots` (with the refreshed `claimed`
      // and `mine`), `joined` and `going`, so the client needs no bespoke shape and no refetch. `joined`
      // is read back from the repo rather than assumed, because a release leaves membership alone while
      // a claim may have just created it.
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
