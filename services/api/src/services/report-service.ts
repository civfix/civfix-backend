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
  ReportTimelineEntryDTO,
  ReportType,
  ReportVisibility,
} from "@civfix/shared"
import { assertNoSlur } from "../abuse/slur-filter.js"
import { isUuid } from "../db/cursor-helpers.js"
import { UNKNOWN_JURCODE } from "../db/reference-code.js"
import { toLinkedEventRef, type LinkedEventView } from "./cleanup-service.js"
import { mapWithLimit } from "../lib/concurrency.js"
import { PRESIGN_CONCURRENCY } from "./media-presign.js"
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
  addressProvenance,
  resolveAddressOrNull,
  type ResolvedAddress,
} from "./address-resolver.js"
import {
  REPORT_AUTOFORWARD_JOB,
  REPORT_CREATE_SCOPE,
  REPORT_VISIBILITY_TIMELINE_KIND,
  REPORTS_DEFAULT_LIMIT,
  REPORTS_SEARCH_DEFAULT_LIMIT,
  type BBox,
  type OwnerToggleStatus,
  type ReportAutoForwardJob,
  type ReportChatMeta,
  type ReportDiscussionMeta,
  type ReportMediaView,
  type ReportOwner,
  type SignedInReportOwner,
  type ReportRecord,
  type ReportSearchInput,
  type ReportService,
  type ReportServiceDeps,
  type ReportTimelineView,
} from "./report-service.types.js"

export * from "./report-service.types.js"
export * from "./report-clustering.js"

const REPORT_NOT_FOUND = "Report not found"
const RESOLVED_BY_REPORTER_NOTE = "Marked resolved by the reporter"
const REOPENED_BY_REPORTER_NOTE = "Reopened by the reporter"
const HIDDEN_BY_REPORTER_NOTE = "Hidden from the public map by the reporter"
const RELISTED_BY_REPORTER_NOTE = "Re-listed by the reporter"

type PresignMedia = ReportServiceDeps["presignMedia"]

interface ReportViewFlags {
  mine: boolean
  mediaPending?: number
  linkedEvents?: LinkedEventRef[]
  discussionMeta?: ReportDiscussionMeta | null
  chatMeta?: ReportChatMeta | null
}

async function toMediaDTO(view: ReportMediaView, presign: PresignMedia): Promise<MediaDTO> {
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

async function toMapPinDTO(pin: UnsignedReportPin, presign: PresignMedia): Promise<ReportPinDTO> {
  let thumbUrl: string | null = null
  if (pin.r2Key !== null) {
    const signed = await presign(pin.r2Key, pin.thumbKey)
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

function discussionFields(meta: ReportDiscussionMeta | null): Partial<ReportDTO> {
  if (meta === null) return {}
  return {
    discussionCount: meta.discussionCount,
    cityHandle: meta.cityHandle,
    cityName: meta.cityName,
    canForwardToCity: meta.canForwardToCity,
  }
}

function chatFields(chat: ReportChatMeta | null): Partial<ReportDTO> {
  if (chat === null) return {}
  return {
    chatJoined: chat.joined,
    chatMemberCount: chat.memberCount,
    chatMessageCount: chat.messageCount,
    chatUnread: chat.unread,
  }
}

export function makeReportService(deps: ReportServiceDeps): ReportService {
  const newId = deps.newId ?? (() => randomUUID())
  const now = deps.now ?? (() => new Date())

  const publicPresign = deps.presignMedia
  const privatePresign = deps.presignPrivateMedia ?? deps.presignMedia

  async function toReportDTO(
    record: ReportRecord,
    media: ReportMediaView[],
    timeline: ReportTimelineView[],
    flags: ReportViewFlags,
  ): Promise<ReportDTO> {
    const reportIsPublic = isPubliclyVisibleStatus(record.status) && record.visibility === "public"
    const mediaDTOs = await mapWithLimit(media, PRESIGN_CONCURRENCY, (view) => {
      const usePrivate = !reportIsPublic || view.status === "validating"
      return toMediaDTO(view, usePrivate ? privatePresign : publicPresign)
    })
    return {
      id: record.id,
      category: record.category,
      type: record.type,
      ...(record.title !== null ? { title: record.title } : {}),
      ...(record.description !== null ? { description: record.description } : {}),
      ...(record.addr !== null ? { addr: record.addr } : {}),
      ...(record.addrSource !== null ? { addrSource: record.addrSource } : {}),
      ...(record.addrPrecision !== null ? { addrPrecision: record.addrPrecision } : {}),
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
      ...discussionFields(flags.discussionMeta ?? null),
      ...chatFields(flags.chatMeta ?? null),
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
    } catch (err) {
      deps.logger?.warn({ err, reportId }, "report: discussion meta failed to load; omitted")
      return null
    }
  }

  async function chatMetaFor(
    reportId: string,
    viewerId: string | null,
  ): Promise<ReportChatMeta | null> {
    if (deps.loadReportChatMeta === undefined) return null
    try {
      return await deps.loadReportChatMeta(reportId, viewerId)
    } catch (err) {
      deps.logger?.warn({ err, reportId }, "report: chat meta failed to load; omitted")
      return null
    }
  }

  async function viewReport(
    record: ReportRecord,
    viewerId: string | null,
  ): Promise<ReportDTO | null> {
    if (record.deletedAt !== null) return null
    const mine = viewerId !== null && record.reporterUserId === viewerId
    const isPublic = isPubliclyVisibleStatus(record.status) && record.visibility === "public"
    if (!isPublic && !mine) return null

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
  }

  // The stored snapshot proves the key was already used, but its presigned media URLs expired minutes after
  // the create while the key lives for days, so a replay answers with the live report whenever it exists.
  async function replayedReport(snapshot: ReportDTO, ownerId: string): Promise<ReportDTO> {
    const record = await deps.repo.findReportById(snapshot.id)
    return (record ? await viewReport(record, ownerId) : null) ?? snapshot
  }

  const service: ReportService = {
    async createReport(input: CreateReportRequest, owner: SignedInReportOwner): Promise<ReportDTO> {
      if (input.honeypot !== undefined && input.honeypot.trim() !== "") {
        throw AppError.validation({ honeypot: "invalid" })
      }

      assertNoSlur(input.title ?? null, "title")
      assertNoSlur(input.description ?? null, "description")
      assertNoSlur(input.addr ?? null, "addr")

      const existing = await deps.repo.findIdempotentSnapshot(
        input.idempotencyKey,
        REPORT_CREATE_SCOPE,
        owner.userId,
      )
      if (existing) return replayedReport(existing, owner.userId)

      const category = REPORT_TYPE_TO_CATEGORY[input.type]

      const suppliedAddr = input.addr?.trim() ?? ""
      const { jurisdictionGeoid, reversed, jurCode } = await resolvePlacement(
        deps,
        input,
        suppliedAddr,
      )
      const h3Cell = reportH3Cell(input.lat, input.lng)
      const publishedAt = now()
      const reportId = newId()
      const addressWrite = addressProvenance(suppliedAddr, reversed)

      const result = await deps.repo.createReportTx({
        reportId,
        reporterUserId: owner.userId,
        guestAnonSessionId: owner.guestAnonSessionId,
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
        addr: addressWrite.addr,
        addrSource: addressWrite.addrSource,
        addrPrecision: addressWrite.addrPrecision,
        status: "published",
        visibility: "public",
        h3Cell,
        publishedAt,
        mediaUploadIds: input.mediaUploadIds,
        timelineNote: null,
        idempotency: {
          key: input.idempotencyKey,
          scope: REPORT_CREATE_SCOPE,
          userOrAnon: owner.userId,
        },
        buildSnapshot: (record, media, timeline) =>
          toReportDTO(record, media, timeline, { mine: true }),
      })

      if (result.kind === "replayed") return replayedReport(result.snapshot, owner.userId)

      await maybeJoinReportChatAsOwner(deps, result.snapshot.id, owner.userId)

      await maybeEnqueueAutoForward(deps, result.snapshot.id, owner.userId)

      return result.snapshot
    },

    async getReport(id: string, viewer: ReportOwner): Promise<ReportDTO> {
      const record = isUuid(id)
        ? await deps.repo.findReportById(id)
        : await deps.repo.findReportByReferenceCode(id)
      const dto = record ? await viewReport(record, viewer.userId ?? null) : null
      if (dto === null) throw AppError.notFound(REPORT_NOT_FOUND)
      return dto
    },

    async listMyReports(
      userId: string,
      pagination: PaginationQuery,
    ): Promise<ListMyReportsResponse> {
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
      const points = await deps.repo.findMapCandidates(
        bbox,
        categories,
        types,
        MAP_REPORTS_CANDIDATE_CAP,
      )
      const { clusters, pins: unsignedPins } = clusterByZoom(points, effectiveMapZoom(bbox, zoom))
      const counts = countByCategory(points)

      const pins: ReportPinDTO[] = await mapWithLimit(unsignedPins, PRESIGN_CONCURRENCY, (pin) =>
        toMapPinDTO(pin, deps.presignMedia),
      )

      return {
        clusters,
        pins,
        ...(Object.keys(counts).length > 0 ? { counts } : {}),
      }
    },

    async searchReports(request: ReportSearchInput): Promise<ListReportsSearchResponse> {
      const q = request.q?.trim() ? request.q.trim() : null
      const categories =
        request.categories !== undefined && request.categories.length > 0
          ? request.categories
          : null
      const types = request.types !== undefined && request.types.length > 0 ? request.types : null
      const cursor = request.cursor ?? null
      const limit = request.limit ?? REPORTS_SEARCH_DEFAULT_LIMIT

      const { points, nextCursor } = await deps.repo.searchReports({
        q,
        categories,
        types,
        cursor,
        limit,
      })

      const items: ReportPinDTO[] = await mapWithLimit(points, PRESIGN_CONCURRENCY, (p) =>
        toMapPinDTO(mapPointToUnsignedPin(p), deps.presignMedia),
      )

      return { items, nextCursor }
    },

    async resolveReport(userId: string, reportId: string, resolved: boolean): Promise<ReportDTO> {
      const status: OwnerToggleStatus = resolved ? "resolved" : "published"
      const note = resolved ? RESOLVED_BY_REPORTER_NOTE : REOPENED_BY_REPORTER_NOTE
      const outcome = await deps.repo.resolveByOwner(reportId, userId, { status, note })
      if (outcome === "not_found") throw AppError.notFound(REPORT_NOT_FOUND)
      if (outcome === "forbidden") {
        throw AppError.forbidden("You can only change the status of your own report")
      }
      if (outcome === "invalid_state") {
        throw AppError.conflict("This report cannot be resolved or reopened from its current state")
      }
      if (outcome === "unchanged") return service.getReport(reportId, { userId })
      await maybeEmitTimeline(deps, { reportId, status, kind: resolved ? "done" : "status", note })
      return service.getReport(reportId, { userId })
    },

    async unlistReport(userId: string, reportId: string, unlisted: boolean): Promise<ReportDTO> {
      const visibility: ReportVisibility = unlisted ? "hidden" : "public"
      const kind = REPORT_VISIBILITY_TIMELINE_KIND[visibility]
      const note = unlisted ? HIDDEN_BY_REPORTER_NOTE : RELISTED_BY_REPORTER_NOTE
      const outcome = await deps.repo.setVisibilityByOwner(reportId, userId, {
        visibility,
        note,
        kind,
      })
      if (outcome === "not_found") throw AppError.notFound(REPORT_NOT_FOUND)
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

async function resolvePlacement(
  deps: ReportServiceDeps,
  input: Pick<CreateReportRequest, "lat" | "lng">,
  suppliedAddr: string,
): Promise<{
  jurisdictionGeoid: string | null
  reversed: ResolvedAddress | null
  jurCode: number
}> {
  const [jurisdictionGeoid, reversed] = await Promise.all([
    deps.resolveJurisdictionGeoid(input.lat, input.lng),
    suppliedAddr.length > 0
      ? Promise.resolve(null)
      : resolveAddressOrNull(deps.resolveAddress, input.lat, input.lng),
  ])
  const jurCode =
    deps.resolveJurisdictionCode !== undefined
      ? await deps.resolveJurisdictionCode(jurisdictionGeoid)
      : UNKNOWN_JURCODE
  return { jurisdictionGeoid, reversed, jurCode }
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
    await deps.jobs.enqueue(REPORT_AUTOFORWARD_JOB, { reportId } satisfies ReportAutoForwardJob, {
      singletonKey: reportId,
    })
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
