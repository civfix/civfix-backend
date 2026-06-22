/**
 * Report service: the create/get/my-list/clustered-map/follow half of the reports domain. All DB access
 * sits behind the ReportRepository seam (Drizzle impl in report-repository.drizzle.ts; an in-memory impl
 * in the offline tests) so the service is unit-testable with no database.
 *
 * IDEMPOTENCY + NO-DUPLICATE + NO-ORPHAN: createReport keys off idempotency_keys (scope "report_create").
 * On the FIRST submit the repository runs ONE transaction that inserts the report, attaches each
 * media_asset (never stealing media already bound to another report), inserts the initial timeline row,
 * AND writes the resulting ReportDTO into idempotency_keys.response_snapshot — atomically. A retry with
 * the same key replays the stored snapshot verbatim (no second row, no second attach, no orphaned R2
 * object). Two concurrent first-submits race on UNIQUE(idempotency_key); the loser gets the winner's
 * stored snapshot. The stored snapshot includes the presigned media URLs at create time, so a replay
 * returns those same (eventually-expiring) URLs — the deliberate "replay the original response" contract;
 * a client needing a fresh URL re-fetches GET /reports/:id (which always re-presigns).
 *
 * HELD/NON-PUBLIC HIDING: getReport returns 404 (never 403, which would leak existence) for a soft-deleted
 * report and for any report that is not (published AND public) UNLESS the viewer owns it — so a stranger
 * cannot tell a held report from a missing one; the owner can still see their own.
 */

import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import type {
  CreateReportRequest,
  LinkedEventRef,
  ListMyReportsResponse,
  ListReportsSearchResponse,
  MediaDTO,
  PaginationQuery,
  ReportCategory,
  ReportClusterResponse,
  ReportDTO,
  ReportPinDTO,
  ReportStatus,
  ReportTimelineEntryDTO,
  ReportType,
  ReportVisibility,
} from "@civfix/shared"
import { assertNoSlur } from "../abuse/slur-filter.js"
import { UNKNOWN_JURCODE } from "../db/reference-code.js"
import { toLinkedEventRef, type LinkedEventView } from "./cleanup-service.js"
import { mapWithLimit, PRESIGN_CONCURRENCY } from "./media-presign.js"
import {
  clusterByZoom,
  countByCategory,
  mapPointToUnsignedPin,
  reportH3Cell,
  MAP_REPORTS_CANDIDATE_CAP,
  type UnsignedReportPin,
} from "./report-clustering.js"
import {
  REPORT_AUTOFORWARD_JOB,
  REPORT_CREATE_SCOPE,
  REPORTS_DEFAULT_LIMIT,
  REPORTS_SEARCH_DEFAULT_LIMIT,
  type BBox,
  type ReportAutoForwardJob,
  type ReportDiscussionMeta,
  type ReportMediaView,
  type ReportOwner,
  type ReportRecord,
  type ReportSearchInput,
  type ReportService,
  type ReportServiceDeps,
  type ReportTimelineView,
} from "./report-service.types.js"

export * from "./report-service.types.js"
export * from "./report-clustering.js"

// 8-4-4-4-12 hex shape (the exact set the Postgres `uuid` type accepts on the reports.id column). Used by
// the resolve-either getReport to decide whether the URL `:id` is a primary key (resolve by id) or a
// reference_code (resolve by code). Deliberately does NOT enforce the v1-5 version/variant nibbles: every
// real id is a valid uuid regardless, and a reference code ("DU-42-000001", "EVENT-...") never matches this
// dash layout + hex-only charset, so the discrimination is unambiguous.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

export function makeReportService(deps: ReportServiceDeps): ReportService {
  const newId = deps.newId ?? (() => randomUUID())
  const now = deps.now ?? (() => new Date())

  async function toMediaDTO(view: ReportMediaView): Promise<MediaDTO> {
    const { url, thumbUrl } = await deps.presignMedia(view.r2Key, view.thumbKey)
    return {
      id: view.id,
      kind: view.kind,
      codec: view.codec,
      url,
      ...(thumbUrl !== undefined ? { thumbUrl } : {}),
      width: view.width,
      height: view.height,
      status: view.status,
    }
  }

  // A pin with no visible media (both keys null) carries thumbUrl:null and makes no presign call. `title`
  // is omitted when null (matching the DTO elsewhere); `description` is always emitted (null when absent).
  async function toMapPinDTO(pin: UnsignedReportPin): Promise<ReportPinDTO> {
    let thumbUrl: string | null = null
    if (pin.r2Key !== null) {
      const signed = await deps.presignMedia(pin.r2Key, pin.thumbKey)
      thumbUrl = signed.thumbUrl ?? signed.url
    }
    return {
      id: pin.id,
      category: pin.category,
      type: pin.type,
      lat: pin.lat,
      lng: pin.lng,
      status: pin.status,
      ...(pin.title !== null ? { title: pin.title } : {}),
      description: pin.description,
      thumbUrl,
    }
  }

  function toTimelineDTO(view: ReportTimelineView): ReportTimelineEntryDTO {
    return {
      status: view.status,
      at: view.createdAt.toISOString(),
      ...(view.note !== null ? { note: view.note } : {}),
      // D13: surface the entry kind + the full body when present (an inbound city reply carries
      // kind='reply' + body). Both are optional non-null on the DTO, so omit when null.
      ...(view.kind !== null ? { kind: view.kind } : {}),
      ...(view.body !== null ? { body: view.body } : {}),
    }
  }

  async function toReportDTO(
    record: ReportRecord,
    media: ReportMediaView[],
    timeline: ReportTimelineView[],
    flags: {
      mine: boolean
      following: boolean
      mediaPending?: number
      linkedEvents?: LinkedEventRef[]
      discussionMeta?: ReportDiscussionMeta | null
    },
  ): Promise<ReportDTO> {
    const mediaDTOs = await mapWithLimit(media, PRESIGN_CONCURRENCY, toMediaDTO)
    const meta = flags.discussionMeta ?? null
    return {
      id: record.id,
      category: record.category,
      type: record.type,
      ...(record.title !== null ? { title: record.title } : {}),
      ...(record.description !== null ? { description: record.description } : {}),
      ...(record.addr !== null ? { addr: record.addr } : {}),
      status: record.status,
      visibility: record.visibility,
      lat: record.lat,
      lng: record.lng,
      geomSource: record.geomSource,
      ...(record.jurisdictionGeoid !== null ? { jurisdictionGeoid: record.jurisdictionGeoid } : {}),
      ...(record.referenceCode !== null ? { referenceCode: record.referenceCode } : {}),
      createdAt: record.createdAt.toISOString(),
      ...(record.publishedAt !== null ? { publishedAt: record.publishedAt.toISOString() } : {}),
      mine: flags.mine,
      gov: false,
      following: flags.following,
      media: mediaDTOs,
      mediaPending: flags.mediaPending ?? 0,
      timeline: timeline.map(toTimelineDTO),
      linkedEvents: flags.linkedEvents ?? [],
      ...(meta !== null
        ? {
            discussionCount: meta.discussionCount,
            cityHandle: meta.cityHandle,
            cityName: meta.cityName,
            canForwardToCity: meta.canForwardToCity,
          }
        : {}),
    }
  }

  async function linkedEventsFor(reportId: string): Promise<LinkedEventRef[]> {
    if (deps.loadLinkedEventsForReports === undefined) return []
    const grouped = await deps.loadLinkedEventsForReports([reportId])
    return (grouped.get(reportId) ?? []).map(toLinkedEventRef)
  }

  // Best-effort: a thrown loader is swallowed (returns null) so the four optional DTO fields are simply
  // omitted and the core report read never fails because the discussion meta was unavailable.
  async function discussionMetaFor(reportId: string): Promise<ReportDiscussionMeta | null> {
    if (deps.loadDiscussionMeta === undefined) return null
    try {
      return await deps.loadDiscussionMeta(reportId)
    } catch {
      return null
    }
  }

  const service: ReportService = {
    async createReport(input: CreateReportRequest, owner: { userId: string }): Promise<ReportDTO> {
      // A non-empty honeypot means a bot filled a hidden field. Reject with a plain VALIDATION envelope
      // (no hint that it was the honeypot) and persist nothing.
      if (input.honeypot !== undefined && input.honeypot.trim() !== "") {
        throw AppError.validation({ honeypot: "invalid" })
      }

      // Hate-slur content gate (App Store 1.2) on the free-text title/description. Slurs only; general
      // profanity passes. Each is checked only when present.
      assertNoSlur(input.title ?? null, "title")
      assertNoSlur(input.description ?? null, "description")

      const existing = await deps.repo.findIdempotentSnapshot(input.idempotencyKey, REPORT_CREATE_SCOPE)
      if (existing) return existing

      // Jurisdiction resolve + reverse-geocode are independent pre-tx lookups; run them concurrently.
      const wantsReverse = !input.addr?.trim() && deps.reverseGeocode !== undefined
      const [jurisdictionGeoid, reversed] = await Promise.all([
        deps.resolveJurisdictionGeoid(input.lat, input.lng),
        wantsReverse ? deps.reverseGeocode!(input.lat, input.lng) : Promise.resolve(null),
      ])
      // Resolve the jurisdiction's compact CODE pre-tx (the reference-code JURCODE segment, D4/D5). A null
      // geoid OR a missing resolver yields UNKNOWN_JURCODE (0) — the unknown bucket, never a crash.
      const jurCode =
        deps.resolveJurisdictionCode !== undefined
          ? await deps.resolveJurisdictionCode(jurisdictionGeoid)
          : UNKNOWN_JURCODE
      const h3Cell = reportH3Cell(input.lat, input.lng)
      const publishedAt = now()
      const reportId = newId()
      const addr = input.addr?.trim() ? input.addr.trim() : reversed

      const result = await deps.repo.createReportTx({
        reportId,
        reporterUserId: owner.userId,
        idempotencyKey: input.idempotencyKey,
        lat: input.lat,
        lng: input.lng,
        geomSource: input.geomSource,
        jurisdictionGeoid,
        jurCode,
        category: input.category,
        type: input.type,
        title: input.title ?? null,
        description: input.description ?? null,
        addr,
        // Authed pins publish immediately (plan 11.7): skip the hold.
        status: "published",
        visibility: "public",
        h3Cell,
        publishedAt,
        mediaUploadIds: input.mediaUploadIds,
        timelineNote: null,
        idempotency: { key: input.idempotencyKey, scope: REPORT_CREATE_SCOPE, userOrAnon: owner.userId },
        buildSnapshot: (record, media, timeline) =>
          toReportDTO(record, media, timeline, { mine: true, following: false }),
      })

      // AUTO-FORWARD (D9 / #56): AFTER the create tx commits (never inside it), enqueue report.autoforward
      // ONLY when the reporter is report_verified. Anonymous/unverified reporters are never enqueued. The
      // singletonKey=reportId dedupes a double-enqueue. Best-effort: a gate-read or enqueue failure is logged
      // and swallowed — the report is already committed + published, and manual routing stays available.
      await maybeEnqueueAutoForward(deps, reportId, owner.userId)

      return result.snapshot
    },

    async getReport(id: string, viewer: ReportOwner): Promise<ReportDTO> {
      // RESOLVE-EITHER (issue #56 / ROUTING): the URL `:id` segment is an opaque string — a UUID primary
      // key OR a reference_code. A UUID-shaped id resolves by primary key; anything else resolves by
      // reference_code. Every MUTATION still keys off the loaded DTO's uuid `id`, so this is read-only.
      const record = isUuid(id)
        ? await deps.repo.findReportById(id)
        : await deps.repo.findReportByReferenceCode(id)
      // Missing OR soft-deleted -> 404 (a deleted report is gone for everyone, including the owner).
      if (!record || record.deletedAt !== null) {
        throw AppError.notFound("Report not found")
      }

      const viewerId = viewer.userId ?? null
      const mine = viewerId !== null && record.reporterUserId === viewerId

      // A report that is not (published AND public) is only visible to its owner; everyone else gets 404
      // (notFound, not forbidden) so a held/hidden report does not leak its existence.
      const isPublic = record.status === "published" && record.visibility === "public"
      if (!isPublic && !mine) {
        throw AppError.notFound("Report not found")
      }

      const [media, timeline, following, validatingCount, linkedEvents, discussionMeta] =
        await Promise.all([
          deps.repo.findMediaForReport(record.id, mine),
          deps.repo.findTimelineForReport(record.id),
          viewerId !== null ? deps.repo.isFollowing(viewerId, record.id) : Promise.resolve(false),
          deps.repo.countValidatingMediaForReport(record.id),
          linkedEventsFor(record.id),
          discussionMetaFor(record.id),
        ])

      // mediaPending = validating media the viewer sees ONLY as a placeholder (those NOT in media[]). The
      // owner's own validating tiles ARE in media[] (ownerView), so subtract them; clamp >= 0 defensively.
      const validatingShown = media.reduce((n, m) => (m.status === "validating" ? n + 1 : n), 0)
      const mediaPending = Math.max(0, validatingCount - validatingShown)

      return toReportDTO(record, media, timeline, {
        mine,
        following,
        mediaPending,
        linkedEvents,
        discussionMeta,
      })
    },

    async listMyReports(userId: string, pagination: PaginationQuery): Promise<ListMyReportsResponse> {
      const cursor = pagination.cursor ?? null
      const limit = pagination.limit ?? REPORTS_DEFAULT_LIMIT
      const { records, nextCursor } = await deps.repo.listMyReports(userId, cursor, limit)

      // Batched reads (instead of 3 queries per row): fetch media, timeline, and the followed-id set for the
      // whole page in one query each, preserving per-item order/filtering. The caller owns all (mine=true).
      const ids = records.map((r) => r.id)
      const [mediaById, timelineById, followed, linkedEventsById] = await Promise.all([
        deps.repo.findMediaForReports(ids, true),
        deps.repo.findTimelineForReports(ids),
        deps.repo.findFollowedReportIds(userId, ids),
        deps.loadLinkedEventsForReports !== undefined
          ? deps.loadLinkedEventsForReports(ids)
          : Promise.resolve(new Map<string, LinkedEventView[]>()),
      ])

      // mapWithLimit preserves input order, so the page keeps its (created_at DESC, id DESC) ordering while
      // bounding concurrent presign signings.
      const items = await mapWithLimit(records, PRESIGN_CONCURRENCY, (record) =>
        toReportDTO(record, mediaById.get(record.id) ?? [], timelineById.get(record.id) ?? [], {
          mine: true,
          following: followed.has(record.id),
          linkedEvents: (linkedEventsById.get(record.id) ?? []).map(toLinkedEventRef),
        }),
      )

      return { items, nextCursor }
    },

    async listReportsInBBox(
      bbox: BBox,
      categories: ReportCategory[] | null,
      types: ReportType[] | null,
      zoom: number,
    ): Promise<ReportClusterResponse> {
      const points = await deps.repo.findMapCandidates(bbox, categories, types, MAP_REPORTS_CANDIDATE_CAP)
      const { clusters, pins: unsignedPins } = clusterByZoom(points, zoom)
      const counts = countByCategory(points)

      // Clustered (zoomed-out) views return no pins; only individual pins are presigned. mapWithLimit caps
      // the concurrent SigV4 signings so a wide pin-zoom view can't fire thousands of R2 ops at once.
      const pins: ReportPinDTO[] = await mapWithLimit(unsignedPins, PRESIGN_CONCURRENCY, toMapPinDTO)

      return {
        clusters,
        pins,
        ...(Object.keys(counts).length > 0 ? { counts } : {}),
      }
    },

    async searchReports(request: ReportSearchInput): Promise<ListReportsSearchResponse> {
      const q = request.q?.trim() ? request.q.trim() : null
      const categories =
        request.categories !== undefined && request.categories.length > 0 ? request.categories : null
      const types = request.types !== undefined && request.types.length > 0 ? request.types : null
      const cursor = request.cursor ?? null
      const limit = request.limit ?? REPORTS_SEARCH_DEFAULT_LIMIT

      const { points, nextCursor } = await deps.repo.searchReports({ q, categories, types, cursor, limit })

      // Search is always an individual-row list; render through the SAME toMapPinDTO path so a search row
      // and a tapped pin render identically, with the presign fan-out bounded.
      const items: ReportPinDTO[] = await mapWithLimit(points, PRESIGN_CONCURRENCY, (p) =>
        toMapPinDTO(mapPointToUnsignedPin(p)),
      )

      return { items, nextCursor }
    },

    async followReport(userId: string, reportId: string): Promise<{ following: boolean }> {
      const exists = await deps.repo.addFollow(userId, reportId)
      if (!exists) throw AppError.notFound("Report not found")
      return { following: true }
    },

    async unfollowReport(userId: string, reportId: string): Promise<{ following: boolean }> {
      const exists = await deps.repo.removeFollow(userId, reportId)
      if (!exists) throw AppError.notFound("Report not found")
      return { following: false }
    },

    async resolveReport(userId: string, reportId: string, resolved: boolean): Promise<ReportDTO> {
      const status: ReportStatus = resolved ? "resolved" : "published"
      const note = resolved ? "Marked resolved by the reporter" : "Reopened by the reporter"
      const outcome = await deps.repo.resolveByOwner(reportId, userId, { status, note })
      if (outcome === "not_found") throw AppError.notFound("Report not found")
      if (outcome === "forbidden") {
        throw AppError.forbidden("You can only change the status of your own report")
      }
      return service.getReport(reportId, { userId })
    },

    async unlistReport(userId: string, reportId: string, unlisted: boolean): Promise<ReportDTO> {
      const visibility: ReportVisibility = unlisted ? "hidden" : "public"
      const note = unlisted ? "Hidden from the public map by the reporter" : "Re-listed by the reporter"
      const outcome = await deps.repo.setVisibilityByOwner(reportId, userId, { visibility, note })
      if (outcome === "not_found") throw AppError.notFound("Report not found")
      if (outcome === "forbidden") {
        throw AppError.forbidden("You can only hide your own report")
      }
      return service.getReport(reportId, { userId })
    },
  }
  return service
}

/**
 * Enqueue the report.autoforward job (D9 / #56) for a just-created report, gated on the reporter being
 * report_verified. The jobs seam + the gate read are BOTH optional + wired together; when either is absent
 * (offline tests / a non-forwarding path) this is a no-op. Anonymous/unverified reporters never enqueue.
 * Runs POST-COMMIT, so any failure (a gate-read throw, an enqueue throw) is logged best-effort and
 * swallowed — the report is already committed + published and manual routing remains available.
 */
async function maybeEnqueueAutoForward(
  deps: ReportServiceDeps,
  reportId: string,
  reporterUserId: string,
): Promise<void> {
  if (deps.jobs === undefined || deps.isReportVerified === undefined) return
  try {
    const verified = await deps.isReportVerified(reporterUserId)
    if (!verified) return
    await deps.jobs.enqueue(
      REPORT_AUTOFORWARD_JOB,
      { reportId } satisfies ReportAutoForwardJob,
      { singletonKey: reportId },
    )
  } catch (err) {
    deps.logger?.warn({ err, reportId }, "report.autoforward enqueue failed")
  }
}
