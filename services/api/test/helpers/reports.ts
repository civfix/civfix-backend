import { randomUUID } from "node:crypto"
import type { ReportVisibilityTimelineKind } from "../../src/services/report-service.js"
import type {
  BBox,
  CreateReportTxArgs,
  CreateReportTxResult,
  OwnerToggleStatus,
  ReportMapPoint,
  ReportMediaView,
  ReportRecord,
  ReportRepository,
  ReportTimelineView,
} from "../../src/services/report-repository.js"
import { formatReferenceCode, reportScopeKey, typeCodeFor } from "../../src/db/reference-code.js"
import {
  isPubliclyVisibleStatus,
  ownerStatusTransition,
} from "../../src/services/report-visibility.js"
import { paginate, parseTimeCursor } from "../../src/db/cursor-helpers.js"
import type { ReportDTO } from "@civfix/shared"

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
  kind?: string | null
  body?: string | null
  createdAt: Date
}

interface StoredIdempotency {
  key: string
  scope: string
  userOrAnon: string | null
  snapshot: ReportDTO
}

export class InMemoryReportRepository implements ReportRepository {
  readonly reports = new Map<string, ReportRecord>()
  readonly media: StoredMediaAsset[] = []
  readonly timeline: StoredTimeline[] = []
  readonly idempotency = new Map<string, StoredIdempotency>()
  private readonly refCounters = new Map<string, number>()

  private allocateReferenceCode(type: ReportRecord["type"], jurCode: number): string {
    const typeCode = typeCodeFor(type)
    const scope = reportScopeKey(typeCode, jurCode)
    const seq = (this.refCounters.get(scope) ?? 0) + 1
    this.refCounters.set(scope, seq)
    return formatReferenceCode(typeCode, jurCode, seq)
  }

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

  private tick = 0
  private nextDate(): Date {
    this.tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, this.tick))
  }

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
      addrSource: over.addrSource ?? null,
      addrPrecision: over.addrPrecision ?? null,
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

  findIdempotentSnapshot(
    key: string,
    scope: string,
    userOrAnon: string | null,
  ): Promise<ReportDTO | null> {
    const found = this.idempotency.get(idempotencyMapKey(scope, key, userOrAnon))
    return Promise.resolve(found ? found.snapshot : null)
  }

  async createReportTx(args: CreateReportTxArgs): Promise<CreateReportTxResult> {
    const idemKey = idempotencyMapKey(
      args.idempotency.scope,
      args.idempotency.key,
      args.idempotency.userOrAnon,
    )
    const prior = this.idempotency.get(idemKey)
    if (prior) return { kind: "replayed", snapshot: prior.snapshot }

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
      addrSource: args.addrSource,
      addrPrecision: args.addrPrecision,
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

    for (const uploadId of args.mediaUploadIds) {
      const asset = this.media.find((m) => m.uploadId === uploadId)
      if (asset && (asset.reportId === null || asset.reportId === record.id)) {
        asset.reportId = record.id
      }
    }

    this.timeline.push({
      reportId: record.id,
      status: args.status,
      note: args.timelineNote,
      createdAt: this.nextDate(),
    })

    const media = await this.loadMedia(record.id)
    const timeline = await this.loadTimeline(record.id)
    const dto = await args.buildSnapshot(record, media, timeline)
    this.idempotency.set(idemKey, {
      key: args.idempotency.key,
      scope: args.idempotency.scope,
      userOrAnon: args.idempotency.userOrAnon,
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
    const r = [...this.reports.values()].find((x) => x.referenceCode === code)
    return Promise.resolve(r ? { ...r } : null)
  }

  findMediaForReport(reportId: string, ownerView = false): Promise<ReportMediaView[]> {
    return this.loadMedia(reportId).then((rows) =>
      rows.filter((m) => m.status === "ready" || (ownerView && m.status === "validating")),
    )
  }

  countValidatingMediaForReport(reportId: string): Promise<number> {
    const n = this.media.filter((m) => m.reportId === reportId && m.status === "validating").length
    return Promise.resolve(n)
  }

  async findMediaForReports(
    reportIds: string[],
    ownerView = false,
  ): Promise<Map<string, ReportMediaView[]>> {
    const grouped = new Map<string, ReportMediaView[]>()
    for (const id of reportIds) {
      grouped.set(id, await this.findMediaForReport(id, ownerView))
    }
    return grouped
  }

  findTimelineForReport(reportId: string): Promise<ReportTimelineView[]> {
    return this.loadTimeline(reportId)
  }

  async findTimelineForReports(reportIds: string[]): Promise<Map<string, ReportTimelineView[]>> {
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
    const anchor = parseTimeCursor(cursor)
    const isBefore = (r: ReportRecord): boolean => {
      if (anchor === null) return true
      const t = r.createdAt.getTime()
      const at = anchor.at.getTime()
      if (t !== at) return t < at
      return r.id < anchor.id
    }
    const all = [...this.reports.values()]
      .filter((r) => r.reporterUserId === userId && r.deletedAt === null)
      .filter((r) => isBefore(r))
      .sort((a, b) => {
        const cmp = b.createdAt.getTime() - a.createdAt.getTime()
        if (cmp !== 0) return cmp
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
      })
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
      return r.id < anchor.id
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
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
      })
    const { items, nextCursor } = paginate(all, args.limit, (r) => ({
      at: r.createdAt,
      id: r.id,
    }))
    const points: ReportMapPoint[] = items.map((r) => {
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
    input: { status: OwnerToggleStatus; note: string },
  ): Promise<"updated" | "unchanged" | "not_found" | "forbidden" | "invalid_state"> {
    const r = this.reports.get(reportId)
    if (!r || r.deletedAt !== null) return Promise.resolve("not_found")
    if (r.reporterUserId !== userId) return Promise.resolve(notOwnerOutcome(r))
    const transition = ownerStatusTransition(r.status, input.status)
    if (transition !== "apply") return Promise.resolve(transition)
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
    input: {
      visibility: ReportRecord["visibility"]
      note: string
      kind: ReportVisibilityTimelineKind
    },
  ): Promise<"updated" | "unchanged" | "not_found" | "forbidden"> {
    const r = this.reports.get(reportId)
    if (!r || r.deletedAt !== null) return Promise.resolve("not_found")
    if (r.reporterUserId !== userId) return Promise.resolve(notOwnerOutcome(r))
    if (r.visibility === input.visibility) return Promise.resolve("unchanged")
    r.visibility = input.visibility
    this.timeline.push({
      reportId,
      status: r.status,
      note: input.note,
      kind: input.kind,
      createdAt: this.nextDate(),
    })
    return Promise.resolve("updated")
  }
}

function notOwnerOutcome(r: {
  status: ReportRecord["status"]
  visibility: ReportRecord["visibility"]
}): "not_found" | "forbidden" {
  const publiclyVisible = isPubliclyVisibleStatus(r.status) && r.visibility === "public"
  return publiclyVisible ? "forbidden" : "not_found"
}

function idempotencyMapKey(scope: string, key: string, userOrAnon: string | null): string {
  return `${scope}:${key}:${userOrAnon ?? ""}`
}
