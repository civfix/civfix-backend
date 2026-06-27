/**
 * Cleanup service: the create/list/get/join/leave half of the cleanups domain, plus the membership that
 * doubles as chat-room membership. All DB access sits behind the CleanupRepository seam (Drizzle/PostGIS
 * impl in cleanup-repository.drizzle.ts; an in-memory impl in the offline tests) so the service is
 * unit-testable with no database.
 *
 * MEMBERSHIP == CHAT MEMBERSHIP, ATOMIC: a cleanup_members row is the single source of truth for both "is
 * going" and "may chat". createCleanup inserts the cleanups row AND the organizer's membership in ONE
 * transaction, so an organizer is never left able to see their event but unable to chat in it, and a
 * rolled-back create never leaves an orphan membership. joinCleanup upserts a member row (idempotent),
 * which is exactly what the WS gateway checks before admitting a socket to room <cleanupId>.
 *
 * ORGANIZER-CANNOT-LEAVE (policy): leaveCleanup refuses to remove the organizer's own membership (a
 * CONFLICT) — every cleanup must always have exactly one organizer; an organizer who wants to end an
 * event cancels it rather than abandoning it. A plain member leaving is always allowed and idempotent.
 *
 * This file is a thin factory + a barrel. The repository interface + structural views live in
 * cleanup-repository.types.ts; the pure DTO projectors + config constants in cleanup-dto.ts. Both are
 * re-exported here so external importers keep the cleanup-service.js entry point.
 */

import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import { UNKNOWN_JURCODE } from "../db/reference-code.js"
import type {
  CleanupAttendeesResponse,
  CleanupDTO,
  CreateCleanupRequest,
  EventKind,
  LinkedReportRef,
  ListCleanupsRequest,
  RequestEventResourcesResponse,
  UpdateCleanupRequest,
} from "@civfix/shared"
import type { OutboundMailService } from "./admin/outbound-mail-service.js"
import { buildEventPacket } from "./admin/mail-format.js"
import { PRESIGN_CONCURRENCY, mapWithLimit } from "./media-presign.js"
import {
  CLEANUPS_DEFAULT_LIMIT,
  ATTENDEES_DEFAULT_LIMIT,
  MAX_LINKED_REPORTS,
  toAttendeePersonDTO,
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
  toAttendeePersonDTO,
  toOrganizerPerson,
  toCleanupDTO,
  toLinkedReportRef,
  toLinkedEventRef,
} from "./cleanup-dto.js"

// A viewer context for read endpoints (a signed-in user, or anonymous).
export interface CleanupViewer {
  userId: string | null
}

// 8-4-4-4-12 hex shape (the exact set the Postgres `uuid` type accepts on cleanups.id) — used by the
// resolve-either getCleanup to decide whether the URL `:id` is a primary key or a reference_code (e.g.
// "EVENT-42-000001"). Like the report path, it does NOT enforce the v1-5 nibbles: an EVENT code never
// matches this dash layout + hex-only charset, so the discrimination is unambiguous.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

export interface CleanupServiceDeps {
  repo: CleanupRepository
  // Presign a linked report's thumb object key into a client-usable URL, wrapping the Storage seam.
  // OPTIONAL: when omitted (offline tests) it defaults to an identity pass-through (returns the raw key)
  // so a test still sees a thumb without a storage SDK.
  presignThumb?: (thumbKey: string) => Promise<string>
  // Resolve the cleanup's point to a jurisdiction geoid (#56 / D6), nullable outside coverage. OPTIONAL:
  // when omitted (offline tests) the cleanup has no resolved jurisdiction (null geoid + jurCode 0).
  resolveJurisdictionGeoid?: (lat: number, lng: number) => Promise<string | null>
  // Resolve a geoid to its compact jurisdictions.code (the EVENT reference-code JURCODE segment).
  // Returns UNKNOWN_JURCODE (0) for a null geoid or one with no code on file (D5). OPTIONAL.
  resolveJurisdictionCode?: (geoid: string | null) => Promise<number>
  // The outbound-mail seam used by requestResources (D19) to send the event packet to the jurisdiction on
  // a per-event thread. OPTIONAL: when omitted (a service built without mail wiring) requestResources is
  // unavailable and throws — the route always wires it in production.
  outboundMail?: OutboundMailService
  // Whether a user is IDENTITY-verified (the requestResources host gate, D19). OPTIONAL for the same reason.
  isVerified?: (userId: string) => Promise<boolean>
  // Injectable id factory (defaults to crypto.randomUUID) for deterministic tests.
  newId?: () => string
}

export interface CleanupService {
  createCleanup(input: CreateCleanupRequest, organizerUserId: string): Promise<CleanupDTO>
  // Organizer edit (PATCH /cleanups/:id). HOST-GATED (else 403). Applies the scalar patch; when
  // `linkedReportIds` is present it reconciles the link set (and rejects linking on a non-cleanup
  // eventKind). Returns the updated CleanupDTO (hydrated linkedReports).
  updateCleanup(
    id: string,
    patch: UpdateCleanupRequest,
    requesterUserId: string,
  ): Promise<CleanupDTO>
  // Cancel an event (POST /cleanups/:id/cancel). HOST-GATED (403); 404 when missing. Sets status
  // 'cancelled', writes a 'cancel' timeline row, and notifies every member, in one repo transaction.
  cancelCleanup(id: string, reason: string | null, requesterUserId: string): Promise<CleanupDTO>
  listCleanups(
    req: ListCleanupsRequest,
    viewer: CleanupViewer,
  ): Promise<{ items: CleanupDTO[]; nextCursor: string | null }>
  getCleanup(id: string, viewer: CleanupViewer): Promise<CleanupDTO>
  joinCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }>
  leaveCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }>
  listAttendees(id: string, viewer: CleanupViewer): Promise<CleanupAttendeesResponse>
  // Request resources from the event's jurisdiction (POST /cleanups/:id/request-resources, D19). HOST-gated
  // (organizer) AND identity-verified (else 403); 404 when missing; 422 NOT_ROUTABLE when the jurisdiction
  // has no contact. Sends the event packet on a per-event mail thread + records a 'resource_request'
  // cleanup_timeline row, then returns { ok: true }.
  requestResources(input: {
    cleanupId: string
    message: string
    actorId: string
  }): Promise<RequestEventResourcesResponse>
}

export function makeCleanupService(deps: CleanupServiceDeps): CleanupService {
  const newId = deps.newId ?? (() => randomUUID())
  const presignThumb = deps.presignThumb ?? ((thumbKey: string) => Promise.resolve(thumbKey))

  // A `function` declaration (not a const arrow) so its `never` return narrows the caller's control flow
  // — `if (!record) notFoundCleanup()` then treats `record` as non-null.
  function notFoundCleanup(): never {
    throw AppError.notFound("Cleanup not found")
  }

  async function viewerJoined(cleanupId: string, viewer: CleanupViewer): Promise<boolean> {
    if (viewer.userId === null) return false
    return deps.repo.isMember(cleanupId, viewer.userId)
  }

  // Hydrate a single cleanup's linkedReports gallery (presigning each report's thumb, bounded). Empty for
  // a non-cleanup eventKind (those carry no links). Used by getCleanup + updateCleanup.
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

  // Batch-hydrate linkedReports for a WHOLE list page (issue #70: the map "blends" an event with its
  // linked reports into one marker, so the LIST endpoint that feeds the map must carry the links the way
  // getCleanup already does). ONE grouped repo load for every cleanup-kind id on the page, then ALL of the
  // page's linked-report thumbs presigned in a SINGLE bounded pass (max concurrency across the page, not a
  // per-event pass), regrouped by cleanup id. Non-cleanup events carry no links, so they are excluded.
  async function hydrateLinkedReportsForMany(
    records: { id: string; eventKind: EventKind }[],
  ): Promise<Map<string, LinkedReportRef[]>> {
    const cleanupIds = records.filter((r) => r.eventKind === "cleanup").map((r) => r.id)
    if (cleanupIds.length === 0) return new Map()
    const grouped = await deps.repo.loadLinkedReportsForCleanups(cleanupIds)
    // Flatten so every linked report across the page presigns in ONE mapWithLimit pass, then regroup.
    const flat: { cleanupId: string; view: LinkedReportView }[] = []
    for (const [cleanupId, views] of grouped) {
      for (const view of views) flat.push({ cleanupId, view })
    }
    const refs = await mapWithLimit(flat, PRESIGN_CONCURRENCY, async ({ cleanupId, view }) => {
      const thumbUrl = view.thumbKey !== null ? await presignThumb(view.thumbKey) : null
      return { cleanupId, ref: toLinkedReportRef(view, thumbUrl) }
    })
    // mapWithLimit preserves input order, so regrouping in `refs` order keeps each event's links in order.
    const out = new Map<string, LinkedReportRef[]>()
    for (const { cleanupId, ref } of refs) {
      const list = out.get(cleanupId)
      if (list) list.push(ref)
      else out.set(cleanupId, [ref])
    }
    return out
  }

  // Validate that every requested link id is visible (published+public). Throws a VALIDATION error naming
  // the offending ids so a host cannot link a held/hidden/missing report.
  async function assertReportsLinkable(reportIds: string[]): Promise<void> {
    if (reportIds.length === 0) return
    const visible = await deps.repo.filterVisibleReportIds(reportIds)
    const bad = reportIds.filter((id) => !visible.has(id))
    if (bad.length > 0) {
      throw AppError.validation({ linkedReportIds: `not linkable: ${bad.join(", ")}` })
    }
  }

  // Backend-side cap on the link set before it reaches the repo's one-tx link path (the shared schema does
  // not advertise a .max(); see cleanup-dto MAX_LINKED_REPORTS).
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
      // CLEANUP-ONLY LINKING (decision 3): only a 'cleanup' event may carry linked reports.
      const linkedReportIds = clampLinkIds(input.linkedReportIds ?? [])
      if (input.eventKind !== "cleanup" && linkedReportIds.length > 0) {
        throw AppError.validation({ linkedReportIds: "only cleanup events can link reports" })
      }
      await assertReportsLinkable(linkedReportIds)

      // Resolve the cleanup's jurisdiction + its compact CODE BEFORE the create tx (#56 / D6), exactly like
      // the report path. A missing resolver, a point outside coverage, or a geoid with no code on file all
      // yield a null geoid + UNKNOWN_JURCODE (0) — the EVENT code still mints in the "0" bucket (D5).
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
      return toCleanupDTO(record, true, linkedReports)
    },

    async updateCleanup(
      id: string,
      patch: UpdateCleanupRequest,
      requesterUserId: string,
    ): Promise<CleanupDTO> {
      // HOST GATE: probe the organizer first so a missing cleanup 404s and a non-organizer 403s before any
      // write.
      const organizerId = await deps.repo.organizerOf(id)
      if (organizerId === null) notFoundCleanup()
      if (organizerId !== requesterUserId) {
        throw AppError.forbidden("Only the organizer can edit this event.")
      }

      // Resolve the effective eventKind AFTER the patch so the cleanup-only rule is enforced against the
      // kind the event WILL have.
      const current = await deps.repo.findCleanupById(id, null)
      if (!current) notFoundCleanup()
      const effectiveKind = patch.eventKind ?? current.eventKind

      // CLEANUP-ONLY LINKING (decision 3): reject a link reconcile on a non-cleanup event.
      if (patch.linkedReportIds !== undefined && effectiveKind !== "cleanup") {
        throw AppError.validation({ linkedReportIds: "only cleanup events can link reports" })
      }
      // When the patch turns a cleanup INTO an other_volunteer event, its existing links must go (the
      // gallery is cleanup-only): reconcile to the empty set unless the caller supplies their own.
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
      const joined = await deps.repo.isMember(id, requesterUserId)
      const linkedReports = await hydrateLinkedReports(id, record.eventKind)
      return toCleanupDTO(record, joined, linkedReports)
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
      // The service owns ALL user-facing copy: the timeline `note` and the notification `body` (the repo
      // only persists). The host is excluded from the notification fan-out by the repo.
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
      const joined = await deps.repo.isMember(id, requesterUserId)
      const linkedReports = await hydrateLinkedReports(id, record.eventKind)
      return toCleanupDTO(record, joined, linkedReports)
    },

    async listCleanups(
      req: ListCleanupsRequest,
      viewer: CleanupViewer,
    ): Promise<{ items: CleanupDTO[]; nextCursor: string | null }> {
      // "attending" is viewer-scoped: an anonymous viewer has no memberships, so short-circuit.
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

      // Resolve `joined` for the WHOLE page in ONE membership query (was an N+1 isMember probe per row).
      const joinedIds =
        viewer.userId !== null
          ? await deps.repo.membersOf(records.map((r) => r.id), viewer.userId)
          : new Set<string>()
      // Hydrate each event's linkedReports for the page (issue #70: the map blends event+reports), in one
      // batched load + bounded presign pass — see hydrateLinkedReportsForMany. Events with no links get [].
      const linkedByCleanup = await hydrateLinkedReportsForMany(records)
      const items = records.map((record) =>
        toCleanupDTO(record, joinedIds.has(record.id), linkedByCleanup.get(record.id) ?? []),
      )
      return { items, nextCursor }
    },

    async getCleanup(id: string, viewer: CleanupViewer): Promise<CleanupDTO> {
      // RESOLVE-EITHER (issue #56 / ROUTING): the URL `:id` is an opaque string — a UUID primary key OR a
      // reference_code. A UUID-shaped id resolves by id; anything else resolves by reference_code. All
      // subsequent reads (membership/links) use the LOADED record's uuid `id`, so this stays read-safe.
      const record = isUuid(id)
        ? await deps.repo.findCleanupById(id, null)
        : await deps.repo.findCleanupByReferenceCode(id)
      if (!record) notFoundCleanup()
      const [joined, linkedReports] = await Promise.all([
        viewerJoined(record.id, viewer),
        hydrateLinkedReports(record.id, record.eventKind),
      ])
      return toCleanupDTO(record, joined, linkedReports)
    },

    async joinCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }> {
      const exists = await deps.repo.joinCleanupTx(id, userId)
      if (!exists) notFoundCleanup()
      const going = await deps.repo.memberCount(id)
      return { joined: true, going }
    },

    async leaveCleanup(id: string, userId: string): Promise<{ joined: boolean; going: number }> {
      // The organizer cannot leave their own cleanup (policy; see file header). Probe the organizer first
      // so a missing cleanup 404s and an organizer self-leave 409s before any delete.
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

      // RSVP unlocks the full roster; until then a viewer sees only attendees they follow. The organizer
      // is always a member, so an organizer always sees everyone.
      const joined = await viewerJoined(id, viewer)
      const scope: CleanupAttendeesResponse["scope"] = joined ? "all" : "following"

      const views = await deps.repo.listAttendees({
        cleanupId: id,
        viewerId: viewer.userId,
        onlyFollowed: !joined,
        limit: ATTENDEES_DEFAULT_LIMIT,
      })
      const attendees = views.map((v) => toAttendeePersonDTO(v, v.isFollowing))
      // `going` is the FULL member count (not the possibly-filtered roster length) so the client can show
      // the real total and an "+N others" overflow regardless of how many names it may display.
      return { attendees, going: record.going, scope }
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

      // HOST + IDENTITY-VERIFIED gate (D19): only the organizer, and only when identity-verified, may
      // request resources. The UI also gates, but enforce server-side. A non-host 403s before the
      // verification read so we don't leak verification state for someone else's event.
      if (record.organizerUserId !== input.actorId) {
        throw AppError.forbidden("Only the event host can request resources.")
      }
      const verified = await deps.isVerified(input.actorId)
      if (!verified) {
        throw AppError.forbidden("Only identity-verified hosts can request resources.")
      }

      // Resolve the event's jurisdiction routing contact (same precedence reports use). No contact -> 422.
      const routing = await deps.repo.resolveJurisdictionContact(record.jurisdictionGeoid)
      if (routing === null) {
        throw AppError.notRoutable(
          "This event's area has no jurisdiction contact on file, so resources can't be requested yet.",
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

      // Record the request in the event timeline (D19) so follow-ups live in the event. `note` is the
      // short request preview; actor is the host.
      await deps.repo.appendCleanupTimeline(record.id, {
        kind: "resource_request",
        note: resourceRequestNote(input.message),
        actorId: input.actorId,
      })
      return { ok: true }
    },
  }
}

/** A short single-line preview of the host's resource-request message for the timeline note. */
function resourceRequestNote(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim()
  const preview = collapsed.length > 140 ? `${collapsed.slice(0, 140)}…` : collapsed
  return preview.length > 0 ? `Resources requested — ${preview}` : "Resources requested"
}
