/**
 * Anonymous reporting service: the logged-out submit + status half of the reports domain, with the
 * full API-layer abuse stack and the hold-then-publish lifecycle.
 *
 * submitAnonReport runs the abuse controls IN ORDER, then creates the report HELD in ONE transaction:
 *
 *   1. Turnstile        verifyTurnstile(token, ip); a failed challenge -> AppError.turnstileFailed.
 *   2. Honeypot         a non-empty hidden field -> silent-ish reject (a plain VALIDATION envelope, no
 *                       hint it was the honeypot) AND a best-effort abuse_flag(reason "honeypot").
 *   3. Anon token       resolve the presented token or issue a fresh one; enforce the per-token cap.
 *   4. Per-IP cap       10/hr per normalized IP (full IPv4 / IPv6 /64) via the CounterStore.
 *   5. Per-H3-cell cap  per-cell hourly cap (ANON-ONLY) via the CounterStore.
 *   6. GPS sanity       compare the point to the coarse IP geo (CF headers). The EXIF cross-check is
 *                       DEFERRED to the worker's release gate; an implausible point -> gpsImplausible.
 *   7. Idempotency      scope "anon_report_create": a duplicate key replays the ORIGINAL response.
 *
 * Then, in a SINGLE transaction (createAnonReportTx): insert the report (reporter_user_id null,
 * anon_session_id = anon token id, status "held", visibility "public", published_at null, jurisdiction
 * resolved, h3_cell, geom), attach media, insert the initial timeline rows (submitted + held), bump the
 * anon_tokens.report_count, stamp a single-use claimCode on the anon_tokens row, and store the
 * AnonReportResponse snapshot in idempotency_keys - all atomically. The media.checks jobs are enqueued
 * after commit (idempotently; a no-op if media-intake already enqueued at finalize).
 *
 * HELD reports stay HIDDEN: the report is created status "held" (NOT published+public), so the existing
 * getReport (404s non-published to strangers) and the map/list candidate queries (published+public
 * only) already exclude it. Its status is observable ONLY via anonReportStatus with the matching
 * claimCode. The worker later releases the hold (see releaseAnonHoldIfReady).
 *
 * anonReportStatus verifies the claimCode against the report's anon token row and returns
 * {status, publishedAt}; a wrong code is NOT-FOUND (no enumeration of report existence).
 */

import { randomUUID, timingSafeEqual } from "node:crypto"
import { AppError } from "@civfix/shared"
import type {
  AnonReportRequest,
  AnonReportResponse,
  AnonReportStatusResponse,
  GeomSource,
  ReportCategory,
  ReportStatus,
} from "@civfix/shared"
import type { AbuseChecks } from "@civfix/shared/interfaces"
import { reportH3Cell } from "./report-service.js"
import type { CounterStore } from "../abuse/counter-store.js"
import { honeypotTripped } from "../abuse/honeypot.js"
import { enforceIpRateLimit } from "../abuse/ip-rate-limit.js"
import { enforceH3CellCap } from "../abuse/h3-cap.js"
import { parseCfGeo, gpsSanityCheck, type HeaderBag } from "../abuse/gps-sanity.js"
import {
  resolveOrIssueAnonToken,
  verifyAnonTokenSignature,
  type AnonTokenDeps,
  type AnonTokenStore,
} from "../abuse/anon-token.js"
import { generateToken } from "../auth/crypto.js"

/** Idempotency scope namespacing anon-report-create keys in idempotency_keys.scope. */
export const ANON_REPORT_CREATE_SCOPE = "anon_report_create"

/** abuse_flags reasons the anon API layer raises (mirrors the shared AbuseReason subset). */
export type AnonAbuseReason = "honeypot" | "gps"

// ---------------------------------------------------------------------------
// Repository seam (faked in tests)
// ---------------------------------------------------------------------------

/** Everything the held-create transaction persists for an anonymous report. */
export interface CreateAnonReportTxArgs {
  reportId: string
  /** The anon token id, stored as reports.anon_session_id. */
  anonSessionId: string
  idempotencyKey: string
  lat: number
  lng: number
  geomSource: GeomSource
  jurisdictionGeoid: string | null
  category: ReportCategory
  description: string | null
  h3Cell: string
  mediaUploadIds: string[]
  /** The single-use claim code to stamp on the anon_tokens row for this submission. */
  claimCode: string
  /** The AnonReportResponse snapshot to persist under the idempotency key (built by the caller). */
  responseSnapshot: AnonReportResponse
}

/** Outcome of a held-create attempt: freshly created, or an idempotent replay of a prior snapshot. */
export type CreateAnonReportTxResult =
  | { kind: "created"; snapshot: AnonReportResponse }
  | { kind: "replayed"; snapshot: AnonReportResponse }

/** The fields anonReportStatus needs to answer a status query and verify the claim code. */
export interface AnonReportStatusRow {
  reportId: string
  status: ReportStatus
  publishedAt: Date | null
  /** The claim code stamped on the report's anon_tokens row (null if none). */
  claimCode: string | null
}

/**
 * Persistence seam for the anonymous-reports flow. Extends the anon_tokens store (the abuse stack uses
 * it to resolve/issue tokens) with the held-create transaction and the status lookup. The production
 * impl runs Drizzle/PostGIS inside a transaction; the offline tests pass an in-memory implementation.
 */
export interface AnonReportRepository extends AnonTokenStore {
  /** Look up a stored AnonReportResponse snapshot for (key, scope); null on a first submit. */
  findIdempotentSnapshot(key: string, scope: string): Promise<AnonReportResponse | null>
  /**
   * Run the held-create transaction: insert the report (held), attach media, insert the submitted+held
   * timeline rows, bump anon_tokens.report_count, stamp the claim code, and persist the snapshot - all
   * atomically. Catches a UNIQUE(idempotency_key) race and returns the stored snapshot as a "replayed"
   * result so the caller still sees the original response.
   */
  createAnonReportTx(args: CreateAnonReportTxArgs): Promise<CreateAnonReportTxResult>
  /** Load the status + claim code for an anon report by id (claim code via its anon_tokens row). */
  findAnonReportStatus(reportId: string): Promise<AnonReportStatusRow | null>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * The per-request transport context the abuse stack reads (IP + CF geo headers + UA). The PRESENTED
 * anon token is NOT here: it travels in the request body (AnonReportRequest.anonToken), which is the
 * single canonical source the service reads, so there is no chance of the two drifting.
 */
export interface AnonSubmitContext {
  ip: string | null
  /** Request headers (or any case-insensitive bag) carrying the Cloudflare geo headers. */
  cfGeo?: HeaderBag | undefined
  userAgent?: string | undefined
}

export interface AnonServiceDeps {
  repo: AnonReportRepository
  abuseChecks: AbuseChecks
  counters: CounterStore
  /** ANON_TOKEN_SIGNING_KEY (HMAC key for the anon token). */
  anonTokenSigningKey: string
  /** Resolve a point to a jurisdiction geoid (nullable outside coverage). Wraps jurisdiction-service. */
  resolveJurisdictionGeoid: (lat: number, lng: number) => Promise<string | null>
  /** Best-effort: raise an abuse_flag against a subject (honeypot/gps). Failure must not block the path. */
  raiseAbuseFlag?: (subjectType: "report" | "anon_token", subjectId: string, reason: AnonAbuseReason) => Promise<void>
  /** Enqueue the media.checks job for each attached media id (idempotent; no-op if already enqueued). */
  enqueueMediaChecks?: (reportId: string, mediaUploadIds: string[]) => Promise<void>
  /** Injectable id factory (defaults to crypto.randomUUID) for the report id. */
  newId?: () => string
  /** Injectable claim-code factory (defaults to a 256-bit base64url token). */
  newClaimCode?: () => string
  /** Injectable clock (defaults to Date.now). */
  now?: () => Date
  /** Injectable anon-token id factory (defaults to a 256-bit base64url token). */
  newAnonTokenId?: () => string
  /** Structured log sink (defaults to a no-op). */
  log?: (line: string, extra?: Record<string, unknown>) => void
}

export interface AnonSubmitResult {
  response: AnonReportResponse
  /**
   * The freshly-issued signed anon token, present ONLY when this submit minted a new token (no valid
   * one was presented). The route hands it back to the client (Set-Cookie for web / response header)
   * so the next submit reuses it. Undefined when an existing token was reused or on an idempotent
   * replay.
   */
  issuedAnonToken?: string
}

export interface AnonService {
  submitAnonReport(input: AnonReportRequest, ctx: AnonSubmitContext): Promise<AnonSubmitResult>
  anonReportStatus(reportId: string, claimCode: string): Promise<AnonReportStatusResponse>
}

export function makeAnonService(deps: AnonServiceDeps): AnonService {
  const now = deps.now ?? (() => new Date())
  const newId = deps.newId ?? (() => randomUUID())
  const newClaimCode = deps.newClaimCode ?? (() => generateToken())
  const log = deps.log ?? (() => {})
  const raiseAbuseFlag = deps.raiseAbuseFlag ?? (() => Promise.resolve())
  const enqueueMediaChecks = deps.enqueueMediaChecks ?? (() => Promise.resolve())

  const tokenDeps: AnonTokenDeps = {
    store: deps.repo,
    signingKey: deps.anonTokenSigningKey,
    now,
    ...(deps.newAnonTokenId !== undefined ? { newId: deps.newAnonTokenId } : {}),
  }

  return {
    async submitAnonReport(
      input: AnonReportRequest,
      ctx: AnonSubmitContext,
    ): Promise<AnonSubmitResult> {
      // (1) Turnstile FIRST: a logged-out submit must clear the human challenge before we spend any
      // other budget (token rows, counters, DB). A failed challenge is a 403 TURNSTILE_FAILED.
      const human = await deps.abuseChecks.verifyTurnstile(input.turnstileToken, ctx.ip ?? "")
      if (!human) {
        throw AppError.turnstileFailed()
      }

      // (2) Honeypot: a non-empty hidden field is a bot. Reject with a generic VALIDATION envelope (no
      // hint that the honeypot tripped) and best-effort flag the anon token if one was presented.
      if (honeypotTripped(input.honeypot)) {
        // Flag the presented token when we can identify it (no row is created for a honeypot hit).
        if (input.anonToken) {
          const presentedId = verifyAnonTokenSignature(input.anonToken, deps.anonTokenSigningKey)
          if (presentedId) {
            await raiseAbuseFlag("anon_token", presentedId, "honeypot").catch(() => {})
          }
        }
        log("anon-submit: honeypot tripped; rejecting", { ip: ctx.ip })
        throw AppError.validation({ honeypot: "invalid" })
      }

      // (3) Anon token: resolve the presented token (from the request body) or issue a fresh one,
      // enforcing the per-token cap.
      const { record: tokenRow, issuedToken } = await resolveOrIssueAnonToken(
        input.anonToken,
        tokenDeps,
      )

      // (4) Per-IP hourly cap (full IPv4 / IPv6 /64).
      await enforceIpRateLimit(ctx.ip, { counters: deps.counters })

      // (5) Per-H3-cell hourly cap (ANON-ONLY; this is the anon path so it always applies).
      await enforceH3CellCap(input.lat, input.lng, { counters: deps.counters })

      // (6) GPS sanity vs the coarse IP geo (CF headers). EXIF is deferred to the worker.
      const ipGeo = ctx.cfGeo ? parseCfGeo(ctx.cfGeo) : null
      const gps = await gpsSanityCheck(
        { point: { lat: input.lat, lng: input.lng }, ipGeo },
        { abuseChecks: deps.abuseChecks, log },
      )
      if (!gps.ok) {
        throw AppError.gpsImplausible()
      }

      // (7) Idempotency fast path: a stored snapshot for this key means a prior submit already created
      // the report. Replay the ORIGINAL AnonReportResponse verbatim (no new row, no quota spent).
      const existing = await deps.repo.findIdempotentSnapshot(
        input.idempotencyKey,
        ANON_REPORT_CREATE_SCOPE,
      )
      if (existing) {
        return { response: existing }
      }

      // First submit. Resolve jurisdiction + compute h3 + mint ids, then run the single held-create tx.
      const jurisdictionGeoid = await deps.resolveJurisdictionGeoid(input.lat, input.lng)
      const h3Cell = reportH3Cell(input.lat, input.lng)
      const reportId = newId()
      const claimCode = newClaimCode()

      const responseSnapshot: AnonReportResponse = {
        reportId,
        status: "held",
        claimCode,
      }

      const result = await deps.repo.createAnonReportTx({
        reportId,
        anonSessionId: tokenRow.id,
        idempotencyKey: input.idempotencyKey,
        lat: input.lat,
        lng: input.lng,
        geomSource: input.geomSource,
        jurisdictionGeoid,
        category: input.category,
        description: input.description ?? null,
        h3Cell,
        mediaUploadIds: input.mediaUploadIds,
        claimCode,
        responseSnapshot,
      })

      // Enqueue media.checks after commit (idempotent). A replay does not re-enqueue (the original
      // submit already did). Best-effort: a queue hiccup must not fail an already-committed report.
      if (result.kind === "created" && input.mediaUploadIds.length > 0) {
        await enqueueMediaChecks(reportId, input.mediaUploadIds).catch((err) => {
          log("anon-submit: media.checks enqueue failed (non-fatal)", {
            reportId,
            err: String(err),
          })
        })
      }

      // On a created result, hand back the freshly-issued token (when one was minted) so the client can
      // store it. A replay returns the original response with no token (the effect already happened).
      return {
        response: result.snapshot,
        ...(result.kind === "created" && issuedToken !== undefined
          ? { issuedAnonToken: issuedToken }
          : {}),
      }
    },

    async anonReportStatus(
      reportId: string,
      claimCode: string,
    ): Promise<AnonReportStatusResponse> {
      const row = await deps.repo.findAnonReportStatus(reportId)
      // No enumeration: a missing report OR a wrong/absent claim code both return NOT-FOUND, so a
      // stranger cannot probe which report ids exist or guess a code by the error shape.
      if (!row || row.claimCode === null || !claimCodeEqual(row.claimCode, claimCode)) {
        throw AppError.notFound("Report not found")
      }
      return {
        status: row.status,
        ...(row.publishedAt !== null ? { publishedAt: row.publishedAt.toISOString() } : {}),
      }
    },
  }
}

/** Constant-time compare of two claim codes (length is not secret; contents are). */
function claimCodeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  // timingSafeEqual requires equal-length buffers; a length mismatch is a definite non-match.
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
