/**
 * Offline reports test helper: an in-memory ReportRepository (plus tiny media/follow stores).
 *
 * Mirrors the auth/media in-memory seams so the report SERVICE and the report HTTP ROUTES can be
 * exercised with NO database (no Docker). It is intentionally faithful to the Drizzle/PostGIS impl's
 * observable contract:
 *   - createReportTx is "atomic": it inserts the report + attaches media + appends the timeline +
 *     stores the snapshot, and if the idempotency key already has a snapshot it does NONE of that and
 *     returns the stored snapshot as a "replayed" result (the no-duplicate + no-orphan guarantee).
 *   - media attach only binds an asset whose report_id is null or already this report (never steals a
 *     foreign asset; unknown upload ids no-op).
 *   - listMyReports pages newest-first with an ISO-timestamp keyset cursor.
 *   - findMapCandidates returns only published + public + non-deleted points whose lat/lng fall inside
 *     the bbox, optionally category-filtered, newest first, capped.
 *
 * The Drizzle-backed repository is covered by the Docker-gated integration test; this fake exercises the
 * same ReportRepository seam.
 */

import { randomUUID } from "node:crypto"
import type {
  BBox,
  CreateReportTxArgs,
  CreateReportTxResult,
  ReportMapPoint,
  ReportMediaView,
  ReportRecord,
  ReportRepository,
  ReportTimelineView,
} from "../../src/services/report-service.js"
import type { ReportDTO } from "@civfix/shared"

/** A stored media asset (the subset the report flow reads + the report_id binding). */
export interface StoredMediaAsset {
  id: string
  uploadId: string
  reportId: string | null
  kind: "image" | "video"
  codec: string | null
  r2Key: string
  thumbKey: string | null
  status: "validating" | "ready" | "rejected" | "held"
  width: number | null
  height: number | null
  createdAt: Date
}

interface StoredTimeline {
  reportId: string
  status: ReportRecord["status"]
  note: string | null
  createdAt: Date
}

interface StoredIdempotency {
  key: string
  scope: string
  snapshot: ReportDTO
}

/** An in-memory ReportRepository faithful to the Drizzle impl's observable behavior. */
export class InMemoryReportRepository implements ReportRepository {
  readonly reports = new Map<string, ReportRecord>()
  readonly media: StoredMediaAsset[] = []
  readonly timeline: StoredTimeline[] = []
  readonly follows = new Set<string>() // `${userId}:${reportId}`
  readonly idempotency = new Map<string, StoredIdempotency>() // `${scope}:${key}`

  /** Monotonic clock so created_at ordering is deterministic across inserts in a single test. */
  private tick = 0
  private nextDate(): Date {
    this.tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, this.tick))
  }

  /** Test helper: seed a finalized media asset (as media-intake would have, report_id still null). */
  seedMedia(over: Partial<StoredMediaAsset> = {}): StoredMediaAsset {
    const asset: StoredMediaAsset = {
      id: over.id ?? randomUUID(),
      uploadId: over.uploadId ?? randomUUID(),
      reportId: over.reportId ?? null,
      kind: over.kind ?? "image",
      codec: over.codec ?? null,
      r2Key: over.r2Key ?? `uploads/2026/01/${"a".repeat(64)}`,
      thumbKey: over.thumbKey ?? null,
      status: over.status ?? "validating",
      width: over.width ?? null,
      height: over.height ?? null,
      createdAt: over.createdAt ?? this.nextDate(),
    }
    this.media.push(asset)
    return asset
  }

  /** Test helper: seed a report record directly (e.g. to set up a held/other-owner getReport case). */
  seedReport(over: Partial<ReportRecord> & { id?: string }): ReportRecord {
    const now = this.nextDate()
    const record: ReportRecord = {
      id: over.id ?? randomUUID(),
      reporterUserId: over.reporterUserId ?? null,
      anonSessionId: over.anonSessionId ?? null,
      category: over.category ?? "trash",
      title: over.title ?? null,
      description: over.description ?? null,
      status: over.status ?? "published",
      visibility: over.visibility ?? "public",
      lat: over.lat ?? 34.1,
      lng: over.lng ?? -118.35,
      geomSource: over.geomSource ?? "device",
      jurisdictionGeoid: over.jurisdictionGeoid ?? null,
      createdAt: over.createdAt ?? now,
      publishedAt: over.publishedAt ?? (over.status === undefined ? now : null),
      deletedAt: over.deletedAt ?? null,
    }
    this.reports.set(record.id, record)
    return record
  }

  findIdempotentSnapshot(key: string, scope: string): Promise<ReportDTO | null> {
    const found = this.idempotency.get(`${scope}:${key}`)
    return Promise.resolve(found ? found.snapshot : null)
  }

  async createReportTx(args: CreateReportTxArgs): Promise<CreateReportTxResult> {
    // Idempotency race: if a snapshot already exists for this key, do nothing and replay it. This
    // mirrors the Drizzle impl catching the UNIQUE(idempotency_key) violation.
    const idemKey = `${args.idempotency.scope}:${args.idempotency.key}`
    const prior = this.idempotency.get(idemKey)
    if (prior) return { kind: "replayed", snapshot: prior.snapshot }

    const createdAt = this.nextDate()
    const record: ReportRecord = {
      id: args.reportId,
      reporterUserId: args.reporterUserId,
      anonSessionId: null,
      category: args.category,
      title: null,
      description: args.description,
      status: args.status,
      visibility: args.visibility,
      lat: args.lat,
      lng: args.lng,
      geomSource: args.geomSource,
      jurisdictionGeoid: args.jurisdictionGeoid,
      createdAt,
      publishedAt: args.publishedAt,
      deletedAt: null,
    }
    this.reports.set(record.id, record)

    // Attach media: bind only assets that are unattached or already ours (never steal a foreign one).
    for (const uploadId of args.mediaUploadIds) {
      const asset = this.media.find((m) => m.uploadId === uploadId)
      if (asset && (asset.reportId === null || asset.reportId === record.id)) {
        asset.reportId = record.id
      }
    }

    // Initial timeline entry.
    this.timeline.push({
      reportId: record.id,
      status: args.status,
      note: args.timelineNote,
      createdAt: this.nextDate(),
    })

    // Build + persist the snapshot from the freshly-stored state (inside the "transaction").
    const media = await this.loadMedia(record.id)
    const timeline = await this.loadTimeline(record.id)
    const dto = await args.buildSnapshot(record, media, timeline)
    this.idempotency.set(idemKey, {
      key: args.idempotency.key,
      scope: args.idempotency.scope,
      snapshot: dto,
    })

    return { kind: "created", snapshot: dto }
  }

  private loadMedia(reportId: string): Promise<ReportMediaView[]> {
    const rows = this.media
      .filter((m) => m.reportId === reportId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((m) => ({
        id: m.id,
        kind: m.kind,
        codec: m.codec,
        r2Key: m.r2Key,
        thumbKey: m.thumbKey,
        status: m.status,
        width: m.width,
        height: m.height,
      }))
    return Promise.resolve(rows)
  }

  private loadTimeline(reportId: string): Promise<ReportTimelineView[]> {
    const rows = this.timeline
      .filter((t) => t.reportId === reportId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((t) => ({ status: t.status, note: t.note, createdAt: t.createdAt }))
    return Promise.resolve(rows)
  }

  findReportById(id: string): Promise<ReportRecord | null> {
    const r = this.reports.get(id)
    return Promise.resolve(r ? { ...r } : null)
  }

  findMediaForReport(reportId: string): Promise<ReportMediaView[]> {
    return this.loadMedia(reportId)
  }

  findTimelineForReport(reportId: string): Promise<ReportTimelineView[]> {
    return this.loadTimeline(reportId)
  }

  isFollowing(userId: string, reportId: string): Promise<boolean> {
    return Promise.resolve(this.follows.has(`${userId}:${reportId}`))
  }

  listMyReports(
    userId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: ReportRecord[]; nextCursor: string | null }> {
    const cursorMs = cursor !== null ? new Date(cursor).getTime() : null
    const all = [...this.reports.values()]
      .filter((r) => r.reporterUserId === userId && r.deletedAt === null)
      .filter((r) => (cursorMs !== null ? r.createdAt.getTime() < cursorMs : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    const hasMore = all.length > limit
    const page = hasMore ? all.slice(0, limit) : all
    const last = page[page.length - 1]
    const nextCursor = hasMore && last ? last.createdAt.toISOString() : null
    return Promise.resolve({ records: page.map((r) => ({ ...r })), nextCursor })
  }

  findMapCandidates(
    bbox: BBox,
    categories: ReportRecord["category"][] | null,
    cap: number,
  ): Promise<ReportMapPoint[]> {
    const inBox = (r: ReportRecord): boolean =>
      r.lng >= bbox.west && r.lng <= bbox.east && r.lat >= bbox.south && r.lat <= bbox.north
    const rows = [...this.reports.values()]
      .filter(
        (r) =>
          r.status === "published" &&
          r.visibility === "public" &&
          r.deletedAt === null &&
          inBox(r) &&
          (categories === null || categories.includes(r.category)),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, cap)
      .map((r) => ({ id: r.id, lat: r.lat, lng: r.lng, category: r.category, status: r.status }))
    return Promise.resolve(rows)
  }

  addFollow(userId: string, reportId: string): Promise<boolean> {
    if (!this.reportExists(reportId)) return Promise.resolve(false)
    this.follows.add(`${userId}:${reportId}`)
    return Promise.resolve(true)
  }

  removeFollow(userId: string, reportId: string): Promise<boolean> {
    if (!this.reportExists(reportId)) return Promise.resolve(false)
    this.follows.delete(`${userId}:${reportId}`)
    return Promise.resolve(true)
  }

  private reportExists(reportId: string): boolean {
    const r = this.reports.get(reportId)
    return r !== undefined && r.deletedAt === null
  }
}
