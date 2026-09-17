/**
 * Offline anonymous-reporting test helpers: in-memory implementations of the anon persistence seams.
 *
 * Mirrors the auth/reports in-memory helpers so the anon SERVICE, the claim SERVICE, the hold-release
 * gate, and the anon/claim HTTP ROUTES can be exercised with NO database (no Docker). Faithful to the
 * Drizzle impls' observable contract:
 *   - createAnonReportTx is atomic: it inserts the report (held), attaches media, appends the
 *     submitted+held timeline, bumps the token's report_count, stamps the claim-code DIGEST, and stores
 *     the snapshot under (scope, key, anon session) - and on a duplicate idempotency key from the SAME
 *     anon session does NONE of that and replays the stored snapshot. A key already spent by a
 *     DIFFERENT anon session never replays (F028); it answers the retryable 409 Postgres produces via
 *     the globally-unique reports.idempotency_key.
 *   - claimByCode matches the stored digest of the presented code (F150 / 0091), links the (unclaimed)
 *     report to the user and clears the digest (single-use); the plaintext code is never stored.
 *
 * The Drizzle-backed repos are covered by the Docker-gated integration test; these fakes exercise the
 * same seams.
 */

import { AppError } from "@civfix/shared"
import type { AddressPrecision, ReportAddressSource } from "@civfix/shared"
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
import {
  formatReferenceCode,
  reportScopeKey,
  typeCodeFor,
} from "../../src/db/reference-code.js"
import type { ReportType } from "@civfix/shared"

/** A stored anon report row (the subset the anon flow reads). */
export interface StoredAnonReport {
  id: string
  reporterUserId: string | null
  anonSessionId: string | null
  category: string
  description: string | null
  /** The creation-time address snapshot and its provenance (0175), as the real insert writes them. */
  addr: string | null
  addrSource: ReportAddressSource | null
  addrPrecision: AddressPrecision | null
  status: ReportStatus
  visibility: "public" | "hidden"
  lat: number
  lng: number
  jurisdictionGeoid: string | null
  h3Cell: string
  /** SHA-256 of the per-report single-use claim code (0091). Cleared on claim. Null for non-anon. */
  claimCodeHash: string | null
  /** The submit's idempotency key, globally unique across reports (reports_idempotency_key_key). */
  idempotencyKey: string | null
  /** The immutable reference code minted at create (#56 / M3). Null on rows seeded without one. */
  referenceCode: string | null
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
  readonly idempotency = new Map<string, AnonReportResponse>() // `${scope}:${key}:${userOrAnon}`
  /** Per-scope reference-code counter, mirroring reference_counters (D4). */
  private readonly refCounters = new Map<string, number>()

  /** Allocate the next reference code for (type, jurCode), mirroring allocateReportReferenceCode (M3). */
  private allocateReferenceCode(type: ReportType, jurCode: number): string {
    const typeCode = typeCodeFor(type)
    const scope = reportScopeKey(typeCode, jurCode)
    const seq = (this.refCounters.get(scope) ?? 0) + 1
    this.refCounters.set(scope, seq)
    return formatReferenceCode(typeCode, jurCode, seq)
  }

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
      addr: over.addr ?? null,
      addrSource: over.addrSource ?? null,
      addrPrecision: over.addrPrecision ?? null,
      status: over.status ?? "held",
      visibility: over.visibility ?? "public",
      lat: over.lat ?? 34.1,
      lng: over.lng ?? -118.35,
      jurisdictionGeoid: over.jurisdictionGeoid ?? null,
      h3Cell: over.h3Cell ?? "8a2830828767fff",
      claimCodeHash: over.claimCodeHash ?? null,
      idempotencyKey: over.idempotencyKey ?? null,
      referenceCode: over.referenceCode ?? null,
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
      findIdempotentSnapshot: (
        key: string,
        scope: string,
        userOrAnon: string | null,
      ): Promise<AnonReportResponse | null> =>
        Promise.resolve(this.idempotency.get(idempotencyMapKey(scope, key, userOrAnon)) ?? null),
      createAnonReportTx: (args: CreateAnonReportTxArgs): Promise<CreateAnonReportTxResult> => {
        const idemKey = idempotencyMapKey(
          "anon_report_create",
          args.idempotencyKey,
          args.anonSessionId,
        )
        const prior = this.idempotency.get(idemKey)
        if (prior) return Promise.resolve({ kind: "replayed", snapshot: prior })

        // reports.idempotency_key is globally unique (0001), so a key already spent by ANOTHER anon
        // session rolls the real transaction back with a 23505 whose owner-scoped snapshot read then
        // misses - the retryable 409 (F028). Modeled here so the fakes answer what Postgres answers
        // instead of silently minting a second report on a squatted key.
        const keyTaken = [...this.reports.values()].some(
          (r) => r.idempotencyKey === args.idempotencyKey,
        )
        if (keyTaken) {
          return Promise.reject(AppError.conflict("Report submit is still settling; retry"))
        }

        // ATOMIC per-token cap (bugs P0-1), mirroring the Drizzle tx: bump report_count ONLY while the
        // token is under the cap, and abort (throw, no writes) otherwise. The whole body runs
        // synchronously here, so two interleaved calls cannot both pass the cap check - exactly the
        // atomic check-and-consume the real UPDATE ... WHERE report_count < cap provides. The claim-code
        // digest is stamped on the REPORT row (0005 / 0091), not the token, so it is not overwritten by
        // later submits.
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

        // D4: allocate the reference code (mirrors the Drizzle held-create tx; anon reports get a code too).
        const referenceCode = this.allocateReferenceCode(args.type, args.jurCode)

        this.seedReport({
          id: args.reportId,
          reporterUserId: null,
          anonSessionId: args.anonSessionId,
          category: args.category,
          description: args.description,
          addr: args.addr,
          addrSource: args.addrSource,
          addrPrecision: args.addrPrecision,
          status: "held",
          visibility: "public",
          lat: args.lat,
          lng: args.lng,
          jurisdictionGeoid: args.jurisdictionGeoid,
          h3Cell: args.h3Cell,
          claimCodeHash: args.claimCodeHash,
          idempotencyKey: args.idempotencyKey,
          referenceCode,
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
        // report_count + the claim-code digest were already stamped atomically above (cap-gated).
        this.idempotency.set(idemKey, args.responseSnapshot)
        return Promise.resolve({ kind: "created", snapshot: args.responseSnapshot })
      },
      findAnonReportStatus: (reportId: string): Promise<AnonReportStatusRow | null> => {
        const r = this.reports.get(reportId)
        if (!r || r.deletedAt !== null) return Promise.resolve(null)
        // Per-report claim-code digest (0091): read it off the report row, not the (overwritten) token
        // row. The caller compares digests, so no plaintext secret is ever handed back.
        return Promise.resolve({
          reportId: r.id,
          status: r.status,
          publishedAt: r.publishedAt,
          claimCodeHash: r.claimCodeHash,
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
      rotatePendingClaimCode: (
        tokenId: string,
        claimCodeHash: string,
      ): Promise<PendingAnonReport | null> => {
        const token = this.tokens.get(tokenId)
        if (!token) return Promise.resolve(null)
        // No plaintext code is stored (0091), so the nudge stamps the caller's freshly minted digest onto
        // the newest unclaimed report of this token, superseding whatever code it carried.
        const report = [...this.reports.values()]
          .filter(
            (r) =>
              r.anonSessionId === tokenId &&
              r.reporterUserId === null &&
              r.deletedAt === null &&
              r.claimCodeHash !== null,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
        if (!report) return Promise.resolve(null)
        report.claimCodeHash = claimCodeHash
        return Promise.resolve({ reportId: report.id })
      },
      claimByCode: (claimCodeHash: string, userId: string): Promise<{ reportId: string } | null> => {
        // Match the report whose stored DIGEST equals the hash of the presented code (0091), not the
        // token. Single-use: a cleared digest no longer matches. anon_session_id is kept as an audit
        // trail.
        const report = [...this.reports.values()].find(
          (r) => r.claimCodeHash === claimCodeHash && r.reporterUserId === null && r.deletedAt === null,
        )
        if (!report) return Promise.resolve(null)
        report.reporterUserId = userId
        report.claimCodeHash = null
        return Promise.resolve({ reportId: report.id })
      },
    }
  }
}

/**
 * Idempotency map key: (scope, key, owner), mirroring the (key, scope, COALESCE(user_or_anon, ''))
 * unique index the real table carries (0078/0079) and the authenticated in-memory repo's helper.
 */
function idempotencyMapKey(scope: string, key: string, userOrAnon: string | null): string {
  return `${scope}:${key}:${userOrAnon ?? ""}`
}
