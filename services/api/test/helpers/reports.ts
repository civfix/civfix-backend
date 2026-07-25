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
 *   - findMapCandidates returns only publicly-visible + public + non-deleted points whose lat/lng fall
 *     inside the bbox, optionally category-filtered, newest first, capped. "Publicly visible" is the
 *     shared isPubliclyVisibleStatus() predicate (src/services/report-visibility.ts), NOT a hardcoded
 *     `status === "published"`: a report stays public while the city works it (acknowledged /
 *     in_progress / resolved), and a hardcoded twin here would silently diverge from the SQL
 *     publicReportFilter() the Drizzle repo uses.
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
import {
  formatReferenceCode,
  reportScopeKey,
  typeCodeFor,
} from "../../src/db/reference-code.js"
import { isPubliclyVisibleStatus } from "../../src/services/report-visibility.js"
// The CANONICAL keyset primitives report-repository.drizzle.ts uses — imported, never re-implemented, so
// the fake cannot drift into accepting a cursor the production parser rejects (or vice versa).
import { paginate, parseTimeCursor } from "../../src/db/cursor-helpers.js"
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
  // D13: optional entry tag + full body (an inbound city reply); default null on status-only rows.
  kind?: string | null
  body?: string | null
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
  readonly idempotency = new Map<string, StoredIdempotency>() // `${scope}:${key}`
  /** Per-scope reference-code counter ("{typecode}:{jurcode}" -> next seq), mirroring reference_counters. */
  private readonly refCounters = new Map<string, number>()

  /** Allocate the next reference code for (type, jurCode), mirroring allocateReportReferenceCode (D4). */
  private allocateReferenceCode(type: ReportRecord["type"], jurCode: number): string {
    const typeCode = typeCodeFor(type)
    const scope = reportScopeKey(typeCode, jurCode)
    const seq = (this.refCounters.get(scope) ?? 0) + 1
    this.refCounters.set(scope, seq)
    return formatReferenceCode(typeCode, jurCode, seq)
  }

  /**
   * The fake's mirror of report-sql.ts:firstReadyStillLateral — the report's first VISIBLE still: a `ready`
   * asset that is an image (its r2_key is a usable full-size fallback) or already carries a poster
   * (thumb_key), ordered (created_at ASC, id ASC) so the pick is total. ONE method for both pin surfaces so
   * the fake cannot drift from the SQL fragment (or from itself).
   */
  private firstReadyStill(reportId: string): StoredMediaAsset | undefined {
    return this.media
      .filter(
        (m) =>
          m.reportId === reportId &&
          m.status === "ready" &&
          (m.kind === "image" || m.thumbKey !== null),
      )
      .sort((a, b) => {
        const cmp = a.createdAt.getTime() - b.createdAt.getTime()
        return cmp !== 0 ? cmp : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })[0]
  }

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
      type: over.type ?? "dump",
      title: over.title ?? null,
      description: over.description ?? null,
      addr: over.addr ?? null,
      status: over.status ?? "published",
      visibility: over.visibility ?? "public",
      lat: over.lat ?? 34.1,
      lng: over.lng ?? -118.35,
      geomSource: over.geomSource ?? "device",
      jurisdictionGeoid: over.jurisdictionGeoid ?? null,
      referenceCode: over.referenceCode ?? null,
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

    // D4: allocate the reference code FIRST (before the report "insert"), mirroring the Drizzle create tx.
    const referenceCode = this.allocateReferenceCode(args.type, args.jurCode)

    const createdAt = this.nextDate()
    const record: ReportRecord = {
      id: args.reportId,
      reporterUserId: args.reporterUserId,
      anonSessionId: null,
      category: args.category,
      type: args.type,
      title: args.title,
      description: args.description,
      addr: args.addr,
      status: args.status,
      visibility: args.visibility,
      lat: args.lat,
      lng: args.lng,
      geomSource: args.geomSource,
      jurisdictionGeoid: args.jurisdictionGeoid,
      referenceCode,
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
      .map((t) => ({
        status: t.status,
        note: t.note,
        kind: t.kind ?? null,
        body: t.body ?? null,
        createdAt: t.createdAt,
      }))
    return Promise.resolve(rows)
  }

  findReportById(id: string): Promise<ReportRecord | null> {
    const r = this.reports.get(id)
    return Promise.resolve(r ? { ...r } : null)
  }

  findReportByReferenceCode(code: string): Promise<ReportRecord | null> {
    // Mirror the Drizzle by-code lookup (reference_code is unique). Includes soft-deleted rows.
    const r = [...this.reports.values()].find((x) => x.referenceCode === code)
    return Promise.resolve(r ? { ...r } : null)
  }

  findMediaForReport(reportId: string, ownerView = false): Promise<ReportMediaView[]> {
    // Public read path: only `ready` media is servable (mirrors the Drizzle impl). The OWNER (ownerView)
    // also sees their own in-flight `validating` uploads; `held`/`rejected` stay hidden from everyone.
    // loadMedia stays unfiltered so the create-tx snapshot still captures just-attached `validating` media.
    return this.loadMedia(reportId).then((rows) =>
      rows.filter((m) => m.status === "ready" || (ownerView && m.status === "validating")),
    )
  }

  countValidatingMediaForReport(reportId: string): Promise<number> {
    // Total in-flight (`validating`) media for the report, for all viewers (mirrors the Drizzle impl);
    // backs the DTO's `mediaPending`. `held`/`rejected` are not counted.
    const n = this.media.filter((m) => m.reportId === reportId && m.status === "validating").length
    return Promise.resolve(n)
  }

  async findMediaForReports(
    reportIds: string[],
    ownerView = false,
  ): Promise<Map<string, ReportMediaView[]>> {
    // Batched mirror of findMediaForReport: same per-report ordering + status filtering, grouped by id.
    const grouped = new Map<string, ReportMediaView[]>()
    for (const id of reportIds) {
      grouped.set(id, await this.findMediaForReport(id, ownerView))
    }
    return grouped
  }

  findTimelineForReport(reportId: string): Promise<ReportTimelineView[]> {
    return this.loadTimeline(reportId)
  }

  async findTimelineForReports(
    reportIds: string[],
  ): Promise<Map<string, ReportTimelineView[]>> {
    const grouped = new Map<string, ReportTimelineView[]>()
    for (const id of reportIds) {
      grouped.set(id, await this.loadTimeline(id))
    }
    return grouped
  }

  listMyReports(
    userId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: ReportRecord[]; nextCursor: string | null }> {
    // Mirror the Drizzle impl's keyset: total order (created_at DESC, id DESC) with a row-value cursor
    // "<iso>|<id>" so a created_at tie at a page boundary never skips a row.
    const anchor = parseTimeCursor(cursor)
    const isBefore = (r: ReportRecord): boolean => {
      if (anchor === null) return true
      const t = r.createdAt.getTime()
      const at = anchor.at.getTime()
      if (t !== at) return t < at
      return r.id < anchor.id // tie on created_at -> compare id (DESC means strictly less)
    }
    const all = [...this.reports.values()]
      .filter((r) => r.reporterUserId === userId && r.deletedAt === null)
      .filter((r) => isBefore(r))
      .sort((a, b) => {
        const cmp = b.createdAt.getTime() - a.createdAt.getTime()
        if (cmp !== 0) return cmp
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0 // id DESC tiebreak
      })
    // Same split + encoder as the Drizzle impl.
    const { items, nextCursor } = paginate(all, limit, (r) => ({ at: r.createdAt, id: r.id }))
    return Promise.resolve({ records: items.map((r) => ({ ...r })), nextCursor })
  }

  findMapCandidates(
    bbox: BBox,
    categories: ReportRecord["category"][] | null,
    types: ReportRecord["type"][] | null,
    cap: number,
  ): Promise<ReportMapPoint[]> {
    const inBox = (r: ReportRecord): boolean =>
      r.lng >= bbox.west && r.lng <= bbox.east && r.lat >= bbox.south && r.lat <= bbox.north
    const rows = [...this.reports.values()]
      .filter(
        (r) =>
          // The TS twin of report-sql.ts:publicReportFilter — read the status set from
          // report-visibility.ts so this fake can never diverge from the Drizzle map query.
          isPubliclyVisibleStatus(r.status) &&
          r.visibility === "public" &&
          r.deletedAt === null &&
          inBox(r) &&
          (categories === null || categories.includes(r.category)) &&
          (types === null || types.includes(r.type)),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, cap)
      .map((r) => {
        // The report's first visible still, projected to its key pair for the pin's thumbUrl. null keys =>
        // the pin carries a null thumb.
        const firstPhoto = this.firstReadyStill(r.id)
        return {
          id: r.id,
          lat: r.lat,
          lng: r.lng,
          category: r.category,
          type: r.type,
          status: r.status,
          title: r.title,
          description: r.description,
          addr: r.addr,
          referenceCode: r.referenceCode,
          thumbKey: firstPhoto?.thumbKey ?? null,
          r2Key: firstPhoto?.r2Key ?? null,
        }
      })
    return Promise.resolve(rows)
  }

  searchReports(args: {
    q: string | null
    categories: ReportRecord["category"][] | null
    types: ReportRecord["type"][] | null
    cursor: string | null
    limit: number
  }): Promise<{ points: ReportMapPoint[]; nextCursor: string | null }> {
    // Mirror the Drizzle impl: publicly visible (isPubliclyVisibleStatus, the TS twin of
    // report-sql.ts:publicReportFilter) + public + non-deleted, optional case-insensitive substring match
    // on title OR addr, optional category filter, total order (created_at DESC, id DESC) with the SAME
    // "<iso>|<id>" row-value keyset cursor as listMyReports, and limit+1 to compute nextCursor.
    const needle = args.q !== null ? args.q.toLowerCase() : null
    const matchesText = (r: ReportRecord): boolean => {
      if (needle === null) return true
      return (
        (r.title !== null && r.title.toLowerCase().includes(needle)) ||
        (r.addr !== null && r.addr.toLowerCase().includes(needle))
      )
    }
    const anchor = parseTimeCursor(args.cursor)
    const isBefore = (r: ReportRecord): boolean => {
      if (anchor === null) return true
      const t = r.createdAt.getTime()
      const at = anchor.at.getTime()
      if (t !== at) return t < at
      return r.id < anchor.id // tie on created_at -> id DESC means strictly less
    }
    const all = [...this.reports.values()]
      .filter(
        (r) =>
          isPubliclyVisibleStatus(r.status) &&
          r.visibility === "public" &&
          r.deletedAt === null &&
          (args.categories === null || args.categories.includes(r.category)) &&
          (args.types === null || args.types.includes(r.type)) &&
          matchesText(r) &&
          isBefore(r),
      )
      .sort((a, b) => {
        const cmp = b.createdAt.getTime() - a.createdAt.getTime()
        if (cmp !== 0) return cmp
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0 // id DESC tiebreak
      })
    // Same split + encoder as the Drizzle impl.
    const { items, nextCursor } = paginate(all, args.limit, (r) => ({
      at: r.createdAt,
      id: r.id,
    }))
    const points: ReportMapPoint[] = items.map((r) => {
      // Same "first visible still" pick as the map path (and as the Drizzle LATERAL).
      const firstPhoto = this.firstReadyStill(r.id)
      return {
        id: r.id,
        lat: r.lat,
        lng: r.lng,
        category: r.category,
        type: r.type,
        status: r.status,
        title: r.title,
        description: r.description,
        addr: r.addr,
        referenceCode: r.referenceCode,
        thumbKey: firstPhoto?.thumbKey ?? null,
        r2Key: firstPhoto?.r2Key ?? null,
      }
    })
    return Promise.resolve({ points, nextCursor })
  }

  resolveByOwner(
    reportId: string,
    userId: string,
    input: { status: ReportRecord["status"]; note: string },
  ): Promise<"updated" | "not_found" | "forbidden"> {
    // Mirror the Drizzle impl: existence + ownership check, then flip status + append a timeline row.
    // The map holds the record by reference, so mutating `r.status` updates the stored report (and
    // findReportById, which returns a copy, then projects the new status).
    const r = this.reports.get(reportId)
    if (!r || r.deletedAt !== null) return Promise.resolve("not_found")
    if (r.reporterUserId !== userId) return Promise.resolve(notOwnerOutcome(r))
    r.status = input.status
    this.timeline.push({
      reportId,
      status: input.status,
      note: input.note,
      createdAt: this.nextDate(),
    })
    return Promise.resolve("updated")
  }

  setVisibilityByOwner(
    reportId: string,
    userId: string,
    input: { visibility: ReportRecord["visibility"]; note: string },
  ): Promise<"updated" | "not_found" | "forbidden"> {
    // Mirror the Drizzle impl: existence + ownership check, then flip visibility + append a timeline row.
    // The status is deliberately NOT changed, so the appended row reuses the report's CURRENT status. The
    // map holds the record by reference, so mutating `r.visibility` updates the stored report (and
    // findReportById, which returns a copy, then projects the new visibility).
    const r = this.reports.get(reportId)
    if (!r || r.deletedAt !== null) return Promise.resolve("not_found")
    if (r.reporterUserId !== userId) return Promise.resolve(notOwnerOutcome(r))
    r.visibility = input.visibility
    this.timeline.push({
      reportId,
      status: r.status,
      note: input.note,
      createdAt: this.nextDate(),
    })
    return Promise.resolve("updated")
  }
}

/**
 * L12: mirrors the Drizzle repo's notOwnerOutcome. A report that is already publicly readable leaks
 * nothing by admitting it exists, so a non-owner gets the honest 403; anything NOT publicly readable
 * (held, submitted, rejected, unlisted) gets the same 404 the read path returns, so the 403/404 split
 * stops being an existence oracle for pre-moderation and owner-hidden content.
 *
 * H8-b: reads the status set from report-visibility.ts (the same isPubliclyVisibleStatus the Drizzle
 * repo's notOwnerOutcome uses) instead of hardcoding `status === "published"` — a report the city has
 * acknowledged / is working / has resolved is still publicly readable, so it must keep the honest 403.
 */
function notOwnerOutcome(r: {
  status: ReportRecord["status"]
  visibility: ReportRecord["visibility"]
}): "not_found" | "forbidden" {
  const publiclyVisible = isPubliclyVisibleStatus(r.status) && r.visibility === "public"
  return publiclyVisible ? "forbidden" : "not_found"
}

