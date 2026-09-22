
import { randomUUID } from "node:crypto"
import { AppError, REPORT_TYPE_TO_CATEGORY } from "@civfix/shared"
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
  effectiveMapZoom,
  mapPointToUnsignedPin,
  reportH3Cell,
  MAP_REPORTS_CANDIDATE_CAP,
  type UnsignedReportPin,
} from "./report-clustering.js"
import { isPubliclyVisibleStatus } from "./report-visibility.js"
import {
  REPORT_AUTOFORWARD_JOB,
  REPORT_CREATE_SCOPE,
  REPORT_VISIBILITY_TIMELINE_KIND,
  REPORTS_DEFAULT_LIMIT,
  REPORTS_SEARCH_DEFAULT_LIMIT,
  type BBox,
  type ReportAutoForwardJob,
  type ReportChatMeta,
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

export function makeReportService(deps: ReportServiceDeps): ReportService {
  const newId = deps.newId ?? (() => randomUUID())
  const now = deps.now ?? (() => new Date())

  const publicPresign = deps.presignMedia
  const privatePresign = deps.presignPrivateMedia ?? deps.presignMedia

  async function toMediaDTO(
    view: ReportMediaView,
    presign: ReportServiceDeps["presignMedia"],
  ): Promise<MediaDTO> {
    const { url, thumbUrl } = await presign(view.r2Key, view.thumbKey)
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
      // <reference>" headline). addr stays nullable; referenceCode is omitted when null, mirroring title.
      addr: pin.addr,
      ...(pin.referenceCode !== null ? { referenceCode: pin.referenceCode } : {}),
    }
  }

  function toTimelineDTO(view: ReportTimelineView): ReportTimelineEntryDTO {
    return {
      status: view.status,
      at: view.createdAt.toISOString(),
      ...(view.note !== null ? { note: view.note } : {}),
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
      mediaPending?: number
      linkedEvents?: LinkedEventRef[]
      discussionMeta?: ReportDiscussionMeta | null
      chatMeta?: ReportChatMeta | null
    },
  ): Promise<ReportDTO> {
    const reportIsPublic =
      isPubliclyVisibleStatus(record.status) && record.visibility === "public"
    const mediaDTOs = await mapWithLimit(media, PRESIGN_CONCURRENCY, (view) => {
      const usePrivate = !reportIsPublic || view.status === "validating"
      return toMediaDTO(view, usePrivate ? privatePresign : publicPresign)
    })
    const meta = flags.discussionMeta ?? null
    const chat = flags.chatMeta ?? null
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
      following: false,
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
      ...(chat !== null
        ? {
            chatJoined: chat.joined,
            chatMemberCount: chat.memberCount,
            chatMessageCount: chat.messageCount,
            chatUnread: chat.unread,
          }
        : {}),
    }
  }

  async function linkedEventsFor(reportId: string): Promise<LinkedEventRef[]> {
    if (deps.loadLinkedEventsForReports === undefined) return []
    const grouped = await deps.loadLinkedEventsForReports([reportId])
    return (grouped.get(reportId) ?? []).map(toLinkedEventRef)
  }

  async function discussionMetaFor(reportId: string): Promise<ReportDiscussionMeta | null> {
    if (deps.loadDiscussionMeta === undefined) return null
    try {
      return await deps.loadDiscussionMeta(reportId)
    } catch {
      return null
    }
  }

  async function chatMetaFor(reportId: string, viewerId: string | null): Promise<ReportChatMeta | null> {
    if (deps.loadReportChatMeta === undefined) return null
    try {
      return await deps.loadReportChatMeta(reportId, viewerId)
    } catch {
      return null
    }
  }

  const service: ReportService = {
    async createReport(input: CreateReportRequest, owner: { userId: string }): Promise<ReportDTO> {
      if (input.honeypot !== undefined && input.honeypot.trim() !== "") {
        throw AppError.validation({ honeypot: "invalid" })
      }

      assertNoSlur(input.title ?? null, "title")
      assertNoSlur(input.description ?? null, "description")

      const existing = await deps.repo.findIdempotentSnapshot(
        input.idempotencyKey,
        REPORT_CREATE_SCOPE,
        owner.userId,
      )
      if (existing) return existing

      const category = REPORT_TYPE_TO_CATEGORY[input.type]

      const wantsReverse = !input.addr?.trim() && deps.reverseGeocode !== undefined
      const [jurisdictionGeoid, reversed] = await Promise.all([
        deps.resolveJurisdictionGeoid(input.lat, input.lng),
        wantsReverse ? deps.reverseGeocode!(input.lat, input.lng) : Promise.resolve(null),
      ])
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
        category,
        type: input.type,
        title: input.title ?? null,
        description: input.description ?? null,
        addr,
        status: "published",
        visibility: "public",
        h3Cell,
        publishedAt,
        mediaUploadIds: input.mediaUploadIds,
        timelineNote: null,
        idempotency: { key: input.idempotencyKey, scope: REPORT_CREATE_SCOPE, userOrAnon: owner.userId },
        buildSnapshot: (record, media, timeline) =>
          toReportDTO(record, media, timeline, { mine: true }),
      })

      if (result.kind === "replayed") return result.snapshot

      await maybeJoinReportChatAsOwner(deps, result.snapshot.id, owner.userId)

      await maybeEnqueueAutoForward(deps, result.snapshot.id, owner.userId)

      return result.snapshot
    },

    async getReport(id: string, viewer: ReportOwner): Promise<ReportDTO> {
      const record = isUuid(id)
        ? await deps.repo.findReportById(id)
        : await deps.repo.findReportByReferenceCode(id)
      if (!record || record.deletedAt !== null) {
        throw AppError.notFound("Report not found")
      }

      const viewerId = viewer.userId ?? null
      const mine = viewerId !== null && record.reporterUserId === viewerId

      const isPublic = isPubliclyVisibleStatus(record.status) && record.visibility === "public"
      if (!isPublic && !mine) {
        throw AppError.notFound("Report not found")
      }

      const [media, timeline, validatingCount, linkedEvents, discussionMeta, chatMeta] =
        await Promise.all([
          deps.repo.findMediaForReport(record.id, mine),
          deps.repo.findTimelineForReport(record.id),
          deps.repo.countValidatingMediaForReport(record.id),
          linkedEventsFor(record.id),
          discussionMetaFor(record.id),
          chatMetaFor(record.id, viewerId),
        ])

      const validatingShown = media.reduce((n, m) => (m.status === "validating" ? n + 1 : n), 0)
      const mediaPending = Math.max(0, validatingCount - validatingShown)

      return toReportDTO(record, media, timeline, {
        mine,
        mediaPending,
        linkedEvents,
        discussionMeta,
        chatMeta,
      })
    },

    async listMyReports(userId: string, pagination: PaginationQuery): Promise<ListMyReportsResponse> {
      const cursor = pagination.cursor ?? null
      const limit = pagination.limit ?? REPORTS_DEFAULT_LIMIT
      const { records, nextCursor } = await deps.repo.listMyReports(userId, cursor, limit)

      const ids = records.map((r) => r.id)
      const [mediaById, timelineById, linkedEventsById] = await Promise.all([
        deps.repo.findMediaForReports(ids, true),
        deps.repo.findTimelineForReports(ids),
        deps.loadLinkedEventsForReports !== undefined
          ? deps.loadLinkedEventsForReports(ids)
          : Promise.resolve(new Map<string, LinkedEventView[]>()),
      ])

      const items = await mapWithLimit(records, PRESIGN_CONCURRENCY, (record) =>
        toReportDTO(record, mediaById.get(record.id) ?? [], timelineById.get(record.id) ?? [], {
          mine: true,
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
      const { clusters, pins: unsignedPins } = clusterByZoom(points, effectiveMapZoom(bbox, zoom))
      const counts = countByCategory(points)

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

      const items: ReportPinDTO[] = await mapWithLimit(points, PRESIGN_CONCURRENCY, (p) =>
        toMapPinDTO(mapPointToUnsignedPin(p)),
      )

      return { items, nextCursor }
    },

    async resolveReport(userId: string, reportId: string, resolved: boolean): Promise<ReportDTO> {
      const status: ReportStatus = resolved ? "resolved" : "published"
      const note = resolved ? "Marked resolved by the reporter" : "Reopened by the reporter"
      const outcome = await deps.repo.resolveByOwner(reportId, userId, { status, note })
      if (outcome === "not_found") throw AppError.notFound("Report not found")
      if (outcome === "forbidden") {
        throw AppError.forbidden("You can only change the status of your own report")
      }
      if (outcome === "invalid_state") {
        throw AppError.conflict("This report cannot be resolved or reopened from its current state")
      }
      await maybeEmitTimeline(deps, { reportId, status, kind: resolved ? "done" : "status", note })
      return service.getReport(reportId, { userId })
    },

    async unlistReport(userId: string, reportId: string, unlisted: boolean): Promise<ReportDTO> {
      const visibility: ReportVisibility = unlisted ? "hidden" : "public"
      const kind = REPORT_VISIBILITY_TIMELINE_KIND[visibility]
      const note = unlisted ? "Hidden from the public map by the reporter" : "Re-listed by the reporter"
      const outcome = await deps.repo.setVisibilityByOwner(reportId, userId, {
        visibility,
        note,
        kind,
      })
      if (outcome === "not_found") throw AppError.notFound("Report not found")
      if (outcome === "forbidden") {
        throw AppError.forbidden("You can only hide your own report")
      }
      const dto = await service.getReport(reportId, { userId })
      if (outcome === "unchanged") return dto
      await maybeEmitTimeline(deps, { reportId, status: dto.status, kind, note })
      return dto
    },
  }
  return service
}

async function maybeEnqueueAutoForward(
  deps: ReportServiceDeps,
  reportId: string,
  reporterUserId: string,
): Promise<void> {
  if (deps.autoForwardEnabled !== true) return
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

async function maybeJoinReportChatAsOwner(
  deps: ReportServiceDeps,
  reportId: string,
  userId: string,
): Promise<void> {
  if (deps.joinReportChatAsOwner === undefined) return
  try {
    await deps.joinReportChatAsOwner(reportId, userId)
  } catch (err) {
    deps.logger?.warn({ err, reportId }, "report-chat: creator auto-join failed")
  }
}

async function maybeEmitTimeline(
  deps: ReportServiceDeps,
  event: { reportId: string; status: string; kind?: string | null; note?: string | null },
): Promise<void> {
  if (deps.reportChatEmitter === undefined) return
  await deps.reportChatEmitter.emit(event)
}
