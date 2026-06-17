/**
 * Report service: the create/get/my-list/clustered-map/follow half of the reports domain.
 *
 * It ties together jurisdiction resolution, the media pipeline, and the report timeline. All DB access
 * sits behind a ReportRepository seam (Drizzle impl in report-repository.drizzle.ts; an in-memory impl
 * in the offline tests), mirroring the auth/media pattern so the service is unit-testable with no
 * database and no Docker.
 *
 * IDEMPOTENCY + NO-DUPLICATE + NO-ORPHAN (the Phase-1 done-criterion and the section-17 probe):
 *   createReport keys off idempotency_keys (scope "report_create"). On the FIRST submit, the repository
 *   runs ONE transaction that: inserts the report row (geom via ST_SetSRID(ST_MakePoint(lng,lat),4326),
 *   geom_source verbatim), attaches each media_asset (sets report_id; never steals media already bound
 *   to another report), inserts the initial timeline row, AND writes the resulting ReportDTO JSON into
 *   idempotency_keys.response_snapshot - all atomically. A retry with the same key finds the snapshot
 *   and replays it verbatim: no second report row, no second media attach, no orphaned R2 object. If two
 *   concurrent first-submits race, the UNIQUE(idempotency_key) on reports (and the PK on
 *   idempotency_keys) trips for the loser; the repository catches that and returns the winner's stored
 *   snapshot, so the caller still sees the original. The media attach is part of the same transaction,
 *   so a rolled-back create never leaves a half-attached asset.
 *
 *   Snapshot freshness note: the stored snapshot is the ReportDTO verbatim, including the media presigned
 *   URLs computed at create time. A replay therefore returns those same URLs even though a presigned URL
 *   eventually expires. This is the deliberate "replay the original response" idempotency contract; a
 *   client that needs a fresh URL re-fetches GET /reports/:id (which always re-presigns). See REPORT.
 *
 * AUTHED PUBLISH-IMMEDIATELY (plan 11.7): a signed-in reporter's pin skips the abuse hold and is created
 * already "published" with published_at = now and visibility "public". The held/abuse path is for the
 * anonymous flow (the next step). The initial timeline entry therefore records "published".
 *
 * HELD/NON-PUBLIC HIDING: getReport returns 404 (notFound, never a 403 that would leak existence) for a
 * soft-deleted report, and for any report that is not (published AND public) UNLESS the viewer owns it.
 * So a stranger cannot tell a held report from a missing one; the owner can still see their own.
 *
 * SPATIAL ACCESS RULE (same as the jurisdiction/cleanup code): every geometry read/write goes through
 * the raw postgres-js tag wrapped in PostGIS functions, never through the Drizzle ORM. Clustering is a
 * PURE function over already-fetched candidate points, so it is unit-testable with no DB.
 */

import { randomUUID } from "node:crypto"
import { latLngToCell } from "h3-js"
import { AppError } from "@civfix/shared"
import type {
  CreateReportRequest,
  GeomSource,
  LinkedEventRef,
  ListMyReportsResponse,
  MediaDTO,
  PaginationQuery,
  ReportCategory,
  ReportClusterDTO,
  ReportClusterResponse,
  ReportDTO,
  ReportPinDTO,
  ReportStatus,
  ReportTimelineEntryDTO,
  ReportVisibility,
} from "@civfix/shared"
import { toLinkedEventRef, type LinkedEventView } from "./cleanup-service.js"

// ---------------------------------------------------------------------------
// Config constants
// ---------------------------------------------------------------------------

/** Idempotency scope namespacing report-create keys in idempotency_keys.scope. */
export const REPORT_CREATE_SCOPE = "report_create"

/**
 * H3 resolution used for reports.h3_cell (the per-report H3 index stored on each row). H3 res 10 cells
 * are ~130 m across (~65 m edge, ~0.015 km^2). This is the SAME granularity the anon abuse cap keys on
 * (abuse/h3-cap.ABUSE_H3_RES), so one operator-facing granularity covers both. It is distinct from the
 * MAP CLUSTER grid below (clusterCellSizeDeg), which is a zoom-derived degree grid, not H3.
 */
export const REPORT_H3_RESOLUTION = 10

/**
 * Max candidate report points pulled from the DB for a single bbox/cluster query. Bounds the payload
 * and the per-request work for a very wide bbox; the clustering then collapses them to far fewer pins.
 * Documented cap: a denser area is sampled (ORDER BY recency) up to this many points.
 */
export const MAP_REPORTS_CANDIDATE_CAP = 2000

/**
 * Zoom at/above which the map returns INDIVIDUAL pins; below it the points are snapped to a grid and
 * returned as clusters with counts. 13 is "neighborhood" zoom - the default the clients land on - so a
 * reporter browsing their area sees individual category pins (each tappable to its detail) rather than
 * count bubbles. Clustering still engages at city/region zoom (<=12), where the candidate count (capped
 * at MAP_REPORTS_CANDIDATE_CAP) would otherwise blow past the "~200 pins at 60fps" render budget.
 */
export const CLUSTER_ZOOM_THRESHOLD = 13

/** Default page size for listMyReports when the request omits `limit`. Matches the shared cap of 50. */
export const REPORTS_DEFAULT_LIMIT = 20

// ---------------------------------------------------------------------------
// Repository seam (structural views; faked in tests)
// ---------------------------------------------------------------------------

/** The owner context (a signed-in user) creating/viewing a report. */
export interface ReportOwner {
  userId?: string | undefined
  anonSessionId?: string | undefined
}

/** A media row as the report service needs it to render a MediaDTO (presign happens in the service). */
export interface ReportMediaView {
  id: string
  kind: "image" | "video"
  codec: string | null
  r2Key: string
  thumbKey: string | null
  status: "validating" | "ready" | "rejected" | "held"
  width: number | null
  height: number | null
}

/** A timeline row as stored, projected for the DTO. */
export interface ReportTimelineView {
  status: ReportStatus
  note: string | null
  createdAt: Date
}

/** The persisted report row the service projects into a ReportDTO (geom already decoded to lat/lng). */
export interface ReportRecord {
  id: string
  reporterUserId: string | null
  anonSessionId: string | null
  category: ReportCategory
  title: string | null
  description: string | null
  addr: string | null
  status: ReportStatus
  visibility: ReportVisibility
  lat: number
  lng: number
  geomSource: GeomSource
  jurisdictionGeoid: string | null
  createdAt: Date
  publishedAt: Date | null
  deletedAt: Date | null
}

/** A candidate map point fetched for clustering (the minimal handle the pure clusterer needs). */
export interface ReportMapPoint {
  id: string
  lat: number
  lng: number
  category: ReportCategory
  status: ReportStatus
}

/** Everything the create transaction needs to persist a report (jurisdiction + h3 already computed). */
export interface CreateReportTxArgs {
  reportId: string
  reporterUserId: string
  idempotencyKey: string
  lat: number
  lng: number
  geomSource: GeomSource
  jurisdictionGeoid: string | null
  category: ReportCategory
  title: string | null
  description: string | null
  addr: string | null
  status: ReportStatus
  visibility: ReportVisibility
  h3Cell: string
  publishedAt: Date | null
  mediaUploadIds: string[]
  /** Initial timeline note (optional). */
  timelineNote: string | null
  /** Idempotency bookkeeping written in the SAME transaction. */
  idempotency: { key: string; scope: string; userOrAnon: string | null }
  /**
   * Build the response snapshot to persist, given the freshly-inserted report record + attached media
   * views + timeline views. Runs INSIDE the transaction so the stored snapshot is exactly the DTO the
   * first caller receives. Returns a JSON-serializable ReportDTO.
   */
  buildSnapshot: (
    record: ReportRecord,
    media: ReportMediaView[],
    timeline: ReportTimelineView[],
  ) => Promise<ReportDTO>
}

/** The outcome of a create attempt: either freshly created, or an idempotent replay of a prior snapshot. */
export type CreateReportTxResult =
  | { kind: "created"; snapshot: ReportDTO }
  | { kind: "replayed"; snapshot: ReportDTO }

/**
 * Persistence seam for the reports domain. The production impl runs Drizzle/PostGIS inside a
 * transaction; the offline tests pass an in-memory implementation. Keeping ALL reports/media-attach/
 * timeline/idempotency access behind this interface is what makes the service testable with no DB.
 */
export interface ReportRepository {
  /** Look up a stored idempotency snapshot for (key, scope); null when this is a first submit. */
  findIdempotentSnapshot(key: string, scope: string): Promise<ReportDTO | null>
  /**
   * Run the create transaction (insert report, attach media, insert timeline, persist snapshot) and
   * return the snapshot. Catches a UNIQUE(idempotency_key) race and returns the stored snapshot as a
   * "replayed" result so the caller still sees the original report.
   */
  createReportTx(args: CreateReportTxArgs): Promise<CreateReportTxResult>
  /** Load a report record by id (including soft-deleted, so the caller can 404 deleted ones). */
  findReportById(id: string): Promise<ReportRecord | null>
  /**
   * Media attached to a report, ordered by created_at. By default returns only `ready` media (the public
   * read path). Pass `ownerView: true` when the VIEWER is the report's owner to ALSO include their own
   * in-flight `validating` uploads, so an owner immediately sees a photo they just attached - before the
   * async media.checks worker promotes it to `ready`. `held`/`rejected` (moderation outcomes) stay hidden
   * from everyone, including the owner.
   */
  findMediaForReport(reportId: string, ownerView?: boolean): Promise<ReportMediaView[]>
  /**
   * Count this report's media still in flight (status `validating`), for ALL viewers. Used to populate
   * the DTO's `mediaPending` so a viewer who does NOT receive a `validating` tile (e.g. a non-owner, who
   * only ever sees `ready` media) can still render a "Photos are still processing…" placeholder, without
   * the server ever serving the unprocessed bytes/URL. `held`/`rejected` are NOT counted (those are
   * moderation outcomes, deliberately hidden — never "pending").
   */
  countValidatingMediaForReport(reportId: string): Promise<number>
  /**
   * Batched form of findMediaForReport for a whole page of report ids (the list read path). Returns a map
   * from reportId -> its visible media (same per-report ordering and `ownerView` filtering as the single
   * form). Ids with no media are absent from the map. An empty input yields an empty map (no query).
   */
  findMediaForReports(
    reportIds: string[],
    ownerView?: boolean,
  ): Promise<Map<string, ReportMediaView[]>>
  /** Timeline entries for a report, ordered by created_at ascending. */
  findTimelineForReport(reportId: string): Promise<ReportTimelineView[]>
  /**
   * Batched form of findTimelineForReport for a whole page of report ids. Returns a map from reportId ->
   * its ordered timeline. Ids with no timeline are absent. An empty input yields an empty map (no query).
   */
  findTimelineForReports(reportIds: string[]): Promise<Map<string, ReportTimelineView[]>>
  /** Whether `userId` follows `reportId`. */
  isFollowing(userId: string, reportId: string): Promise<boolean>
  /**
   * Batched follow probe: of the given report ids, which does `userId` follow? Returns the followed subset
   * as a Set. An empty input yields an empty set (no query). Used by the list path to resolve `following`
   * for a whole page in one query instead of one per row.
   */
  findFollowedReportIds(userId: string, reportIds: string[]): Promise<Set<string>>
  /**
   * Page the caller's own (non-deleted) reports, newest first. `cursor` is an opaque keyset cursor; the
   * impl returns up to `limit` records plus the next cursor (null when exhausted).
   */
  listMyReports(
    userId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: ReportRecord[]; nextCursor: string | null }>
  /** Fetch up to `cap` published+public+non-deleted candidate points inside the bbox, newest first. */
  findMapCandidates(
    bbox: BBox,
    categories: ReportCategory[] | null,
    cap: number,
  ): Promise<ReportMapPoint[]>
  /** Upsert a follow; returns true if the report exists (so the route can 404 a missing report). */
  addFollow(userId: string, reportId: string): Promise<boolean>
  /** Delete a follow; returns true if the report exists. */
  removeFollow(userId: string, reportId: string): Promise<boolean>
}

/** Plain bbox (west/south/east/north) - re-declared structurally to avoid importing the zod type here. */
export interface BBox {
  west: number
  south: number
  east: number
  north: number
}

/**
 * Additive discussion/city meta for a report's DETAIL read. All fields map 1:1 onto the optional ReportDTO
 * fields (discussionCount / cityHandle / cityName / canForwardToCity). Resolved from the report's
 * jurisdiction + the discussion table by loadDiscussionMeta; absent => the fields are omitted from the DTO.
 */
export interface ReportDiscussionMeta {
  /** Count of NON-deleted top-level discussion messages for the report. */
  discussionCount: number
  /** The report jurisdiction's effective handle (stored or derived), or null when Unmapped. */
  cityHandle: string | null
  /** The report jurisdiction's display name, or null when Unmapped. */
  cityName: string | null
  /** Whether the jurisdiction has at least one usable contact email (so a @city forward could deliver). */
  canForwardToCity: boolean
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB, no IO)
// ---------------------------------------------------------------------------

/** Compute the H3 cell index for a point at the report resolution. Pure; wraps h3-js. */
export function reportH3Cell(lat: number, lng: number): string {
  return latLngToCell(lat, lng, REPORT_H3_RESOLUTION)
}

/**
 * Map CLUSTER grid cell size (in DEGREES) used to snap points into clusters at a given zoom. This is the
 * separate clustering granularity, SEPARATE from the H3 reports.h3_cell above (which is for the abuse cap
 * / a coarse spatial key, not the map). Halves with each zoom step so the world stays partitioned into
 * ~constant screen-space tiles. Tuned so that below the threshold a wide view yields a handful of
 * clusters rather than hundreds of pins.
 */
export function clusterCellSizeDeg(zoom: number): number {
  // Defense-in-depth NaN/non-finite guard (P2): a non-finite zoom (e.g. NaN slipping past a caller that
  // does not validate) would otherwise yield a NaN cell size -> every point maps to a "NaN:NaN" grid key
  // -> one cluster at NaN coords (serializes to null = a broken pin). Treat a non-finite zoom as 0 (the
  // coarsest, widest cell) so clustering still produces a valid result. The route additionally rejects a
  // bad zoom with a 422 before reaching here.
  const safeZoom = Number.isFinite(zoom) ? zoom : 0
  // 360 degrees split into 2^(zoom+1) columns. At zoom 0 that is 180deg; at zoom 13 ~ 0.022deg.
  const z = Math.max(0, Math.floor(safeZoom))
  return 360 / Math.pow(2, z + 1)
}

/**
 * PURE server-side clustering keyed by zoom.
 *
 *   - At/above CLUSTER_ZOOM_THRESHOLD: emit every point as an individual ReportPinDTO (no clusters).
 *   - Below it: snap each point to a grid cell (size from clusterCellSizeDeg(zoom)) and emit one
 *     ReportClusterDTO per non-empty cell, positioned at the centroid of the cell's points with the
 *     point count. No pins are returned in this mode.
 *
 * Deterministic (cells iterated in insertion order) so tests can assert exact output. No DB access:
 * callers fetch candidate points (capped) and pass them in. This backs the "60fps with 200 pins" goal
 * by keeping the rendered marker count bounded when zoomed out.
 */
export function clusterByZoom(
  points: ReportMapPoint[],
  zoom: number,
): { clusters: ReportClusterDTO[]; pins: ReportPinDTO[] } {
  if (zoom >= CLUSTER_ZOOM_THRESHOLD) {
    const pins: ReportPinDTO[] = points.map((p) => ({
      id: p.id,
      category: p.category,
      lat: p.lat,
      lng: p.lng,
      status: p.status,
    }))
    return { clusters: [], pins }
  }

  const size = clusterCellSizeDeg(zoom)
  // Accumulate per-cell sums for a centroid + count. Keyed by integer grid coordinates.
  const cells = new Map<string, { latSum: number; lngSum: number; count: number }>()
  for (const p of points) {
    const gx = Math.floor(p.lng / size)
    const gy = Math.floor(p.lat / size)
    const key = `${gx}:${gy}`
    const cell = cells.get(key)
    if (cell) {
      cell.latSum += p.lat
      cell.lngSum += p.lng
      cell.count += 1
    } else {
      cells.set(key, { latSum: p.lat, lngSum: p.lng, count: 1 })
    }
  }

  const clusters: ReportClusterDTO[] = []
  for (const cell of cells.values()) {
    clusters.push({
      lat: cell.latSum / cell.count,
      lng: cell.lngSum / cell.count,
      count: cell.count,
    })
  }
  return { clusters, pins: [] }
}

/**
 * PURE per-category pin count over the candidate set. Always counts ALL candidates (independent of the
 * cluster/pin split) so the filter popover shows how many reports of each category are in view. Only
 * categories with a non-zero count are present in the record.
 */
export function countByCategory(points: ReportMapPoint[]): Partial<Record<ReportCategory, number>> {
  const counts: Partial<Record<ReportCategory, number>> = {}
  for (const p of points) {
    counts[p.category] = (counts[p.category] ?? 0) + 1
  }
  return counts
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ReportServiceDeps {
  repo: ReportRepository
  /**
   * Resolve a point to a jurisdiction geoid (nullable when outside coverage). Wraps the
   * jurisdiction-service so the report service does not import the spatial SQL directly and so it can be
   * faked offline. May also enqueue discovery (a side effect of the real impl); the report service does
   * not depend on that.
   */
  resolveJurisdictionGeoid: (lat: number, lng: number) => Promise<string | null>
  /**
   * Best-effort reverse geocoder: turn the report's pin into a one-line address when the reporter did
   * not supply one, so every report carries a location label for the list/detail. OPTIONAL and nullable
   * - a missing seam or a null result simply leaves `addr` empty (the prior behavior); it must never
   * block creation. The real impl is a street-level Photon lookup with a local "City, ST" fallback.
   */
  reverseGeocode?: (lat: number, lng: number) => Promise<string | null>
  /**
   * Presign (or otherwise render) the URL pair for a media object. Wraps the Storage seam; returns a
   * url and an optional thumbUrl. Injected so the service stays free of the storage SDK and is fakeable.
   */
  presignMedia: (
    r2Key: string,
    thumbKey: string | null,
  ) => Promise<{ url: string; thumbUrl?: string }>
  /**
   * Load the events (cleanups) a set of reports is linked to, grouped by report id (the report's
   * "linked events" gallery). OPTIONAL: wraps the cleanup repo's loadLinkedEventsForReports so the report
   * service does not depend on the cleanup repo directly and stays fakeable. When omitted, linkedEvents is
   * always [] (the additive DTO default), so an un-wired or offline path simply renders no gallery.
   */
  loadLinkedEventsForReports?: (
    reportIds: string[],
  ) => Promise<Map<string, LinkedEventView[]>>
  /**
   * Load the additive discussion/city meta for a single report's DETAIL (GET /reports/:id): the count of
   * NON-deleted top-level discussion messages, the report's jurisdiction handle + name, and whether the
   * jurisdiction has at least one contact email (so the client can offer "forward to city"). OPTIONAL:
   * wraps a small discussion-repo read so the report service does not depend on the discussion repo
   * directly and stays fakeable. When omitted (offline/un-wired paths) the four DTO fields are simply
   * absent (they are all optional/additive). Best-effort: a thrown loader is swallowed by getReport so the
   * core report read never fails because the discussion meta could not be loaded.
   */
  loadDiscussionMeta?: (reportId: string) => Promise<ReportDiscussionMeta>
  /** Injectable id factory (defaults to crypto.randomUUID) for deterministic tests. */
  newId?: () => string
  /** Injectable clock (defaults to Date.now) so published_at/created_at are deterministic in tests. */
  now?: () => Date
}

export interface ReportService {
  createReport(input: CreateReportRequest, owner: { userId: string }): Promise<ReportDTO>
  getReport(id: string, viewer: ReportOwner): Promise<ReportDTO>
  listMyReports(userId: string, pagination: PaginationQuery): Promise<ListMyReportsResponse>
  listReportsInBBox(
    bbox: BBox,
    categories: ReportCategory[] | null,
    zoom: number,
  ): Promise<ReportClusterResponse>
  followReport(userId: string, reportId: string): Promise<{ following: boolean }>
  unfollowReport(userId: string, reportId: string): Promise<{ following: boolean }>
}

export function makeReportService(deps: ReportServiceDeps): ReportService {
  const newId = deps.newId ?? (() => randomUUID())
  const now = deps.now ?? (() => new Date())

  /** Render a stored media view into a presigned MediaDTO. */
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

  /** Map a timeline view to its DTO. */
  function toTimelineDTO(view: ReportTimelineView): ReportTimelineEntryDTO {
    return {
      status: view.status,
      at: view.createdAt.toISOString(),
      ...(view.note !== null ? { note: view.note } : {}),
    }
  }

  /**
   * Assemble a full ReportDTO from a record + its media/timeline, presigning media URLs. `mine`/
   * `following` are computed by the caller (they depend on the viewer). `gov` is always false in Phase
   * 1 (no gov-authored reports yet). `mediaPending` (default 0) is the count of in-flight media this
   * viewer will see only as a "processing" placeholder (validating media NOT in the returned `media[]`),
   * so a non-owner can render the placeholder without the unprocessed bytes being served.
   */
  async function toReportDTO(
    record: ReportRecord,
    media: ReportMediaView[],
    timeline: ReportTimelineView[],
    flags: {
      mine: boolean
      following: boolean
      mediaPending?: number
      linkedEvents?: LinkedEventRef[]
      /** Additive discussion/city meta (DETAIL read only); absent => the four fields are omitted. */
      discussionMeta?: ReportDiscussionMeta | null
    },
  ): Promise<ReportDTO> {
    const mediaDTOs = await Promise.all(media.map(toMediaDTO))
    const meta = flags.discussionMeta ?? null
    return {
      id: record.id,
      category: record.category,
      ...(record.title !== null ? { title: record.title } : {}),
      ...(record.description !== null ? { description: record.description } : {}),
      ...(record.addr !== null ? { addr: record.addr } : {}),
      status: record.status,
      visibility: record.visibility,
      lat: record.lat,
      lng: record.lng,
      geomSource: record.geomSource,
      ...(record.jurisdictionGeoid !== null
        ? { jurisdictionGeoid: record.jurisdictionGeoid }
        : {}),
      createdAt: record.createdAt.toISOString(),
      ...(record.publishedAt !== null ? { publishedAt: record.publishedAt.toISOString() } : {}),
      mine: flags.mine,
      gov: false,
      following: flags.following,
      media: mediaDTOs,
      mediaPending: flags.mediaPending ?? 0,
      timeline: timeline.map(toTimelineDTO),
      linkedEvents: flags.linkedEvents ?? [],
      // Additive discussion/city meta (DETAIL only). Each field is emitted only when the meta was loaded, so
      // the list/create paths (which pass no meta) keep their exact prior shape.
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

  /**
   * Load + project the events a single report is linked to (its "linked events" gallery). Empty when the
   * loader is not wired (offline/un-wired paths). Used by getReport; listMyReports uses the batched form.
   */
  async function linkedEventsFor(reportId: string): Promise<LinkedEventRef[]> {
    if (deps.loadLinkedEventsForReports === undefined) return []
    const grouped = await deps.loadLinkedEventsForReports([reportId])
    return (grouped.get(reportId) ?? []).map(toLinkedEventRef)
  }

  /**
   * Load the additive discussion/city meta for a report (DETAIL only), or null when the loader is not wired
   * OR the load fails. Best-effort: a thrown loader is swallowed (returns null) so the four optional DTO
   * fields are simply omitted and the core report read never fails because the discussion meta was
   * unavailable.
   */
  async function discussionMetaFor(reportId: string): Promise<ReportDiscussionMeta | null> {
    if (deps.loadDiscussionMeta === undefined) return null
    try {
      return await deps.loadDiscussionMeta(reportId)
    } catch {
      return null
    }
  }

  return {
    async createReport(input: CreateReportRequest, owner: { userId: string }): Promise<ReportDTO> {
      // (a) Honeypot: a non-empty value means a bot filled a hidden field. Reject silently-ish (a plain
      // VALIDATION envelope, no hint that it was the honeypot) and DO NOT create anything.
      if (input.honeypot !== undefined && input.honeypot.trim() !== "") {
        throw AppError.validation({ honeypot: "invalid" })
      }

      // (b) Idempotency fast path: a stored snapshot for this key means a prior submit already created
      // the report. Replay it verbatim (no new row, no media attach, no R2 object). This is the
      // IDEMPOTENT_REPLAY semantics expressed as returning the original ReportDTO.
      const existing = await deps.repo.findIdempotentSnapshot(input.idempotencyKey, REPORT_CREATE_SCOPE)
      if (existing) return existing

      // (c) First submit. Resolve jurisdiction (nullable) and compute the H3 cell up front (both are
      // deterministic given the point); then run the single create transaction.
      const jurisdictionGeoid = await deps.resolveJurisdictionGeoid(input.lat, input.lng)
      const h3Cell = reportH3Cell(input.lat, input.lng)
      const publishedAt = now()
      const reportId = newId()
      // When the client supplied no address, derive one from the pin (best-effort; null on any failure
      // so it never blocks creation) so the list/detail always show a location label.
      const addr = input.addr?.trim()
        ? input.addr.trim()
        : deps.reverseGeocode
          ? await deps.reverseGeocode(input.lat, input.lng)
          : null

      const result = await deps.repo.createReportTx({
        reportId,
        reporterUserId: owner.userId,
        idempotencyKey: input.idempotencyKey,
        lat: input.lat,
        lng: input.lng,
        geomSource: input.geomSource,
        jurisdictionGeoid,
        category: input.category,
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
        idempotency: {
          key: input.idempotencyKey,
          scope: REPORT_CREATE_SCOPE,
          userOrAnon: owner.userId,
        },
        // The snapshot is built INSIDE the transaction from the freshly-persisted rows, so a duplicate
        // submit replays exactly what the first caller received. mine=true (the creator owns it),
        // following=false (creating does not auto-follow).
        buildSnapshot: (record, media, timeline) =>
          toReportDTO(record, media, timeline, { mine: true, following: false }),
      })

      return result.snapshot
    },

    async getReport(id: string, viewer: ReportOwner): Promise<ReportDTO> {
      const record = await deps.repo.findReportById(id)
      // Missing OR soft-deleted -> 404 (a deleted report is gone for everyone, including the owner).
      if (!record || record.deletedAt !== null) {
        throw AppError.notFound("Report not found")
      }

      const viewerId = viewer.userId ?? null
      const mine = viewerId !== null && record.reporterUserId === viewerId

      // Visibility: a report that is not (published AND public) is only visible to its owner. Everyone
      // else gets a 404 (notFound, not forbidden) so a held/hidden report does not leak its existence.
      const isPublic = record.status === "published" && record.visibility === "public"
      if (!isPublic && !mine) {
        throw AppError.notFound("Report not found")
      }

      const [media, timeline, following, validatingCount, linkedEvents, discussionMeta] =
        await Promise.all([
          // The owner sees their own in-flight (`validating`) media too; strangers get `ready` only.
          deps.repo.findMediaForReport(record.id, mine),
          deps.repo.findTimelineForReport(record.id),
          viewerId !== null ? deps.repo.isFollowing(viewerId, record.id) : Promise.resolve(false),
          // Total in-flight (`validating`) media for the report — independent of the viewer's filter.
          deps.repo.countValidatingMediaForReport(record.id),
          // The cleanup events this report is linked to (its "linked events" gallery; carries linkedAt so the
          // client synthesizes the report-side "Linked to cleanup X" timeline node - no report_timeline write).
          linkedEventsFor(record.id),
          // Additive discussion/city meta (count + city handle/name + can-forward). Best-effort: a thrown
          // loader resolves to null so the four optional DTO fields are simply omitted and the core report
          // read never fails on it. Absent loader (offline/un-wired) => null => fields omitted.
          discussionMetaFor(record.id),
        ])

      // `mediaPending` = validating media the viewer will see ONLY as a "processing" placeholder, i.e.
      // those NOT already in the returned media[]. For the owner, their own validating tiles ARE in media[]
      // (ownerView), so subtract them out (no double-count); a non-owner gets the full validating count
      // since they receive no validating tiles. Clamp to >= 0 to be defensive against any read skew.
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

    async listMyReports(
      userId: string,
      pagination: PaginationQuery,
    ): Promise<ListMyReportsResponse> {
      const cursor = pagination.cursor ?? null
      const limit = pagination.limit ?? REPORTS_DEFAULT_LIMIT
      const { records, nextCursor } = await deps.repo.listMyReports(userId, cursor, limit)

      // BATCHED reads: instead of 3 queries per row (the old 1+3N N+1), fetch media, timeline, and the
      // followed-id set for the WHOLE page in one query each, then regroup in memory. The order/filtering
      // of each item is unchanged: the page records keep their listMyReports order, and per-report media
      // ordering + ownerView filtering and timeline ordering are preserved inside the batched repo calls.
      // The caller owns all of them (mine=true); `following` comes from the per-page followed-id set.
      const ids = records.map((r) => r.id)
      const [mediaById, timelineById, followed, linkedEventsById] = await Promise.all([
        // "Your reports": the viewer is always the owner, so include their in-flight media too.
        deps.repo.findMediaForReports(ids, true),
        deps.repo.findTimelineForReports(ids),
        deps.repo.findFollowedReportIds(userId, ids),
        // Linked events for the whole page in one batched query (empty map when the loader is not wired).
        deps.loadLinkedEventsForReports !== undefined
          ? deps.loadLinkedEventsForReports(ids)
          : Promise.resolve(new Map<string, LinkedEventView[]>()),
      ])

      // toReportDTO is async (it signs media URLs), so build the page's DTOs in parallel. Promise.all
      // preserves input order, so the page keeps its listMyReports (created_at DESC, id DESC) ordering.
      const items = await Promise.all(
        records.map((record) =>
          toReportDTO(record, mediaById.get(record.id) ?? [], timelineById.get(record.id) ?? [], {
            mine: true,
            following: followed.has(record.id),
            linkedEvents: (linkedEventsById.get(record.id) ?? []).map(toLinkedEventRef),
          }),
        ),
      )

      return { items, nextCursor }
    },

    async listReportsInBBox(
      bbox: BBox,
      categories: ReportCategory[] | null,
      zoom: number,
    ): Promise<ReportClusterResponse> {
      // Fetch a capped candidate set (published + public + not deleted, inside the bbox). Clustering and
      // counting are pure functions over this set, so the heavy lifting is unit-testable without a DB.
      const points = await deps.repo.findMapCandidates(bbox, categories, MAP_REPORTS_CANDIDATE_CAP)
      const { clusters, pins } = clusterByZoom(points, zoom)
      const counts = countByCategory(points)

      return {
        clusters,
        pins,
        // Only include counts when there is at least one candidate, so an empty view omits the field.
        ...(Object.keys(counts).length > 0 ? { counts } : {}),
      }
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
  }
}
