/**
 * Offline anonymous-reporting test helpers: in-memory implementations of the anon persistence seams.
 *
 * Mirrors the auth/reports in-memory helpers so the anon SERVICE, the claim SERVICE, the hold-release
 * gate, and the anon/claim HTTP ROUTES can be exercised with NO database (no Docker). Faithful to the
 * Drizzle impls' observable contract:
 *   - createAnonReportTx is atomic: it inserts the report (held), attaches media, appends the
 *     submitted+held timeline, bumps the token's report_count, stamps the claim code, and stores the
 *     snapshot - and on a duplicate idempotency key does NONE of that and replays the stored snapshot.
 *   - claimByCode links the (unclaimed) report to the user and clears the claim code (single-use).
 *
 * The Drizzle-backed repos are covered by the Docker-gated integration test; these fakes exercise the
 * same seams.
 */

import { AppError } from "@civfix/shared"
import type { AnonReportResponse, ReportStatus } from "@civfix/shared"
import type { LatLng } from "@civfix/shared"
import type { AnonTokenRecord } from "../../src/abuse/anon-token.js"
import type {
  AnonReportRepository,
  AnonReportStatusRow,
  CreateAnonReportTxArgs,
  CreateAnonReportTxResult,
} from "../../src/services/anon-service.js"
import type {
  AnonHoldReleaseRepo,
  HeldReportView,
  ReleaseMediaView,
} from "../../src/services/anon-hold-release.js"
import type { ClaimRepository, PendingAnonReport } from "../../src/services/claim-service.js"

/** A stored anon report row (the subset the anon flow reads). */
export interface StoredAnonReport {
  id: string
  reporterUserId: string | null
  anonSessionId: string | null
  category: string
  description: string | null
  status: ReportStatus
  visibility: "public" | "hidden"
  lat: number
  lng: number
  jurisdictionGeoid: string | null
  h3Cell: string
  /** Per-report single-use claim code (0005). Cleared on claim. Null for non-anon reports. */
  claimCode: string | null
  createdAt: Date
  publishedAt: Date | null
  deletedAt: Date | null
}

/** A stored media asset for the anon/release flow. */
export interface StoredAnonMedia {
  id: string
  uploadId: string
  reportId: string | null
  status: "validating" | "ready" | "rejected" | "held"
  exifGeo?: LatLng | null
  createdAt: Date
}

interface StoredTimeline {
  reportId: string
  status: ReportStatus
  note: string | null
  createdAt: Date
}

interface StoredFlag {
  subjectType: "report" | "media" | "anon_token"
  subjectId: string
  reason: string
  resolvedAt: Date | null
}

/**
 * A single in-memory store backing ALL three anon seams (report repo, hold-release repo, claim repo).
 * Sharing one store lets a test create via the anon service and then release via the worker gate
 * against the same rows, exactly like production shares one database.
 */
export class InMemoryAnonStore {
  readonly tokens = new Map<string, AnonTokenRecord>()
  readonly reports = new Map<string, StoredAnonReport>()
  readonly media: StoredAnonMedia[] = []
  readonly timeline: StoredTimeline[] = []
  readonly flags: StoredFlag[] = []
  readonly idempotency = new Map<string, AnonReportResponse>() // `${scope}:${key}`

  private tick = 0
  private nextDate(): Date {
    this.tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, this.tick))
  }

  // ---- seed helpers ----

  seedToken(over: Partial<AnonTokenRecord> = {}): AnonTokenRecord {
    // Default the expiry to 24h from the REAL current time so a seeded token is valid under a service
    // using the default Date.now() clock (the deterministic 2026-01-01 nextDate() is only used for
    // ordering, not lifetime). Callers that test expiry pass an explicit expiresAt.
    const at = over.createdAt ?? this.nextDate()
    const row: AnonTokenRecord = {
      id: over.id ?? `tok-${this.tick}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: at,
      expiresAt: over.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
      reportCount: over.reportCount ?? 0,
      flagged: over.flagged ?? false,
      claimCode: over.claimCode ?? null,
    }
    this.tokens.set(row.id, row)
    return row
  }

  seedReport(over: Partial<StoredAnonReport> & { id?: string }): StoredAnonReport {
    const now = this.nextDate()
    const row: StoredAnonReport = {
      id: over.id ?? `rep-${this.tick}-${Math.random().toString(36).slice(2, 8)}`,
      reporterUserId: over.reporterUserId ?? null,
      anonSessionId: over.anonSessionId ?? null,
      category: over.category ?? "trash",
      description: over.description ?? null,
      status: over.status ?? "held",
      visibility: over.visibility ?? "public",
      lat: over.lat ?? 34.1,
      lng: over.lng ?? -118.35,
      jurisdictionGeoid: over.jurisdictionGeoid ?? null,
      h3Cell: over.h3Cell ?? "8a2830828767fff",
      claimCode: over.claimCode ?? null,
      createdAt: over.createdAt ?? now,
      publishedAt: over.publishedAt ?? null,
      deletedAt: over.deletedAt ?? null,
    }
    this.reports.set(row.id, row)
    return row
  }

  seedMedia(over: Partial<StoredAnonMedia> & { reportId: string }): StoredAnonMedia {
    const row: StoredAnonMedia = {
      id: over.id ?? `med-${this.tick}-${Math.random().toString(36).slice(2, 8)}`,
      uploadId: over.uploadId ?? `up-${Math.random().toString(36).slice(2, 8)}`,
      reportId: over.reportId,
      status: over.status ?? "validating",
      exifGeo: over.exifGeo ?? null,
      createdAt: over.createdAt ?? this.nextDate(),
    }
    this.media.push(row)
    return row
  }

  seedOpenFlag(subjectType: StoredFlag["subjectType"], subjectId: string, reason = "nsfw"): void {
    this.flags.push({ subjectType, subjectId, reason, resolvedAt: null })
  }

  // ---- AnonReportRepository ----

  anonReportRepo(): AnonReportRepository {
    // Arrow-function properties so `this` is the store instance (no this-aliasing).
    return {
      insert: (row: AnonTokenRecord): Promise<void> => {
        this.tokens.set(row.id, { ...row })
        return Promise.resolve()
      },
      findById: (id: string): Promise<AnonTokenRecord | null> => {
        const t = this.tokens.get(id)
        return Promise.resolve(t ? { ...t } : null)
      },
      findIdempotentSnapshot: (key: string, scope: string): Promise<AnonReportResponse | null> =>
        Promise.resolve(this.idempotency.get(`${scope}:${key}`) ?? null),
      createAnonReportTx: (args: CreateAnonReportTxArgs): Promise<CreateAnonReportTxResult> => {
        const idemKey = `anon_report_create:${args.idempotencyKey}`
        const prior = this.idempotency.get(idemKey)
        if (prior) return Promise.resolve({ kind: "replayed", snapshot: prior })

        // ATOMIC per-token cap (bugs P0-1), mirroring the Drizzle tx: bump report_count ONLY while the
        // token is under the cap, and abort (throw, no writes) otherwise. The whole body runs
        // synchronously here, so two interleaved calls cannot both pass the cap check - exactly the
        // atomic check-and-consume the real UPDATE ... WHERE report_count < cap provides. The claim code
        // is stamped on the REPORT row (0005), not the token, so it is not overwritten by later submits.
        const token = this.tokens.get(args.anonSessionId)
        if (token && token.reportCount >= args.reportCap) {
          return Promise.reject(
            AppError.rateLimited(
              "This anonymous session has reached its report limit. Sign in to continue.",
            ),
          )
        }
        if (token) {
          token.reportCount += 1
        }

        this.seedReport({
          id: args.reportId,
          reporterUserId: null,
          anonSessionId: args.anonSessionId,
          category: args.category,
          description: args.description,
          status: "held",
          visibility: "public",
          lat: args.lat,
          lng: args.lng,
          jurisdictionGeoid: args.jurisdictionGeoid,
          h3Cell: args.h3Cell,
          claimCode: args.claimCode,
          publishedAt: null,
        })
        // Attach media (only unattached or already-ours).
        for (const uploadId of args.mediaUploadIds) {
          const asset = this.media.find((m) => m.uploadId === uploadId)
          if (asset && (asset.reportId === null || asset.reportId === args.reportId)) {
            asset.reportId = args.reportId
          }
        }
        // Timeline: submitted + held.
        this.timeline.push({
          reportId: args.reportId,
          status: "submitted",
          note: null,
          createdAt: this.nextDate(),
        })
        this.timeline.push({
          reportId: args.reportId,
          status: "held",
          note: "Awaiting automated review",
          createdAt: this.nextDate(),
        })
        // report_count + claim_code were already bumped atomically above (cap-gated).
        this.idempotency.set(idemKey, args.responseSnapshot)
        return Promise.resolve({ kind: "created", snapshot: args.responseSnapshot })
      },
      findAnonReportStatus: (reportId: string): Promise<AnonReportStatusRow | null> => {
        const r = this.reports.get(reportId)
        if (!r || r.deletedAt !== null) return Promise.resolve(null)
        // Per-report claim code (0005): read it off the report row, not the (overwritten) token row.
        return Promise.resolve({
          reportId: r.id,
          status: r.status,
          publishedAt: r.publishedAt,
          claimCode: r.claimCode,
        })
      },
    }
  }

  // ---- AnonHoldReleaseRepo ----

  holdReleaseRepo(): AnonHoldReleaseRepo {
    // Arrow-function properties so `this` is the store instance (no this-aliasing).
    return {
      findReport: (reportId: string): Promise<HeldReportView | null> => {
        const r = this.reports.get(reportId)
        if (!r) return Promise.resolve(null)
        return Promise.resolve({
          id: r.id,
          reporterUserId: r.reporterUserId,
          anonSessionId: r.anonSessionId,
          status: r.status,
          visibility: r.visibility,
          lat: r.lat,
          lng: r.lng,
          deletedAt: r.deletedAt,
        })
      },
      findMedia: (reportId: string): Promise<ReleaseMediaView[]> =>
        Promise.resolve(
          this.media
            .filter((m) => m.reportId === reportId)
            .map((m) => ({ id: m.id, status: m.status, exifGeo: m.exifGeo ?? null })),
        ),
      countOpenAbuseFlags: (reportId: string, mediaIds: string[]): Promise<number> => {
        const n = this.flags.filter(
          (f) =>
            f.resolvedAt === null &&
            ((f.subjectType === "report" && f.subjectId === reportId) ||
              (f.subjectType === "media" && mediaIds.includes(f.subjectId))),
        ).length
        return Promise.resolve(n)
      },
      publishHeldReport: (reportId: string, publishedAt: Date): Promise<boolean> => {
        const r = this.reports.get(reportId)
        if (!r || r.status !== "held" || r.deletedAt !== null) return Promise.resolve(false)
        r.status = "published"
        r.publishedAt = publishedAt
        this.timeline.push({
          reportId,
          status: "published",
          note: "Released after automated review",
          createdAt: this.nextDate(),
        })
        return Promise.resolve(true)
      },
      findHeldAnonReportIds: (limit: number): Promise<string[]> => {
        const ids = [...this.reports.values()]
          .filter((r) => r.status === "held" && r.reporterUserId === null && r.deletedAt === null)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit)
          .map((r) => r.id)
        return Promise.resolve(ids)
      },
    }
  }

  // ---- ClaimRepository ----

  claimRepo(): ClaimRepository {
    // Arrow-function properties so `this` is the store instance (no this-aliasing).
    return {
      insert: (row: AnonTokenRecord): Promise<void> => {
        this.tokens.set(row.id, { ...row })
        return Promise.resolve()
      },
      findById: (id: string): Promise<AnonTokenRecord | null> => {
        const t = this.tokens.get(id)
        return Promise.resolve(t ? { ...t } : null)
      },
      findPendingByTokenId: (tokenId: string): Promise<PendingAnonReport | null> => {
        const token = this.tokens.get(tokenId)
        if (!token) return Promise.resolve(null)
        // The claim code is per-report (0005): the nudge surfaces the newest unclaimed report that still
        // carries its own code.
        const report = [...this.reports.values()]
          .filter(
            (r) =>
              r.anonSessionId === tokenId &&
              r.reporterUserId === null &&
              r.deletedAt === null &&
              r.claimCode !== null,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
        if (!report || report.claimCode === null) return Promise.resolve(null)
        return Promise.resolve({ reportId: report.id, claimCode: report.claimCode })
      },
      claimByCode: (claimCode: string, userId: string): Promise<{ reportId: string } | null> => {
        // Match the specific report carrying this per-report code (0005), not the token. Single-use:
        // a cleared code no longer matches. anon_session_id is kept as an audit trail.
        const report = [...this.reports.values()].find(
          (r) => r.claimCode === claimCode && r.reporterUserId === null && r.deletedAt === null,
        )
        if (!report) return Promise.resolve(null)
        report.reporterUserId = userId
        report.claimCode = null
        return Promise.resolve({ reportId: report.id })
      },
    }
  }
}
