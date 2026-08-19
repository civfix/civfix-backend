
import { randomUUID } from "node:crypto"
import { AppError, REPORT_TYPE_TO_CATEGORY } from "@civfix/shared"
import type {
  AnonReportRequest,
  AnonReportResponse,
  AnonReportStatusResponse,
  GeomSource,
  LatLng,
  ReportCategory,
  ReportType,
  ReportStatus,
} from "@civfix/shared"
import { assertNoSlur } from "../abuse/slur-filter.js"
import type { AbuseChecks } from "@civfix/shared/interfaces"
import { reportH3Cell } from "./report-service.js"
import type { CounterStore } from "../abuse/counter-store.js"
import { honeypotTripped } from "../abuse/honeypot.js"
import { enforceIpRateLimit } from "../abuse/ip-rate-limit.js"
import { enforceH3CellCap } from "../abuse/h3-cap.js"
import { parseCfGeo, gpsSanityCheck, type HeaderBag } from "../abuse/gps-sanity.js"
import {
  ensureAnonToken,
  resolveAnonToken,
  verifyAnonTokenSignature,
  ANON_TOKEN_REPORT_CAP,
  type AnonTokenDeps,
  type AnonTokenStore,
} from "../abuse/anon-token.js"
import { generateToken, constantTimeStringEqual, sha256Hex } from "../auth/crypto.js"
import { UNKNOWN_JURCODE } from "../db/reference-code.js"

export const ANON_REPORT_CREATE_SCOPE = "anon_report_create"

export const ANON_TURNSTILE_ACTION = "anon-report"

export const ANON_MAX_MEDIA_UPLOADS = 5

export type AnonAbuseReason = "honeypot" | "gps"

export interface CreateAnonReportTxArgs {
  reportId: string
  anonSessionId: string
  idempotencyKey: string
  lat: number
  lng: number
  geomSource: GeomSource
  jurisdictionGeoid: string | null
  jurCode: number
  category: ReportCategory
  type: ReportType
  title: string | null
  description: string | null
  addr: string | null
  h3Cell: string
  mediaUploadIds: string[]
  claimCodeHash: string
  reportCap: number
  responseSnapshot: AnonReportResponse
}

export type CreateAnonReportTxResult =
  | { kind: "created"; snapshot: AnonReportResponse }
  | { kind: "replayed"; snapshot: AnonReportResponse }

export interface AnonReportStatusRow {
  reportId: string
  status: ReportStatus
  publishedAt: Date | null
  claimCodeHash: string | null
}

export interface AnonReportRepository extends AnonTokenStore {
  findIdempotentSnapshot(
    key: string,
    scope: string,
    userOrAnon: string | null,
  ): Promise<AnonReportResponse | null>
  createAnonReportTx(args: CreateAnonReportTxArgs): Promise<CreateAnonReportTxResult>
  findAnonReportStatus(reportId: string): Promise<AnonReportStatusRow | null>
}

export interface AnonSubmitContext {
  ip: string | null
  cfGeo?: HeaderBag | undefined
  cfGeoTrusted?: boolean | undefined
  userAgent?: string | undefined
}

export interface AnonServiceDeps {
  repo: AnonReportRepository
  abuseChecks: AbuseChecks
  counters: CounterStore
  anonTokenSigningKey: string
  resolveJurisdictionGeoid: (lat: number, lng: number) => Promise<string | null>
  resolveJurisdictionCode?: (geoid: string | null) => Promise<number>
  reverseGeocode?: (lat: number, lng: number) => Promise<string | null>
  raiseAbuseFlag?: (subjectType: "report" | "anon_token", subjectId: string, reason: AnonAbuseReason) => Promise<void>
  enqueueMediaChecks?: (reportId: string, mediaUploadIds: string[]) => Promise<void>
  newId?: () => string
  newClaimCode?: () => string
  now?: () => Date
  newAnonTokenId?: () => string
  log?: (line: string, extra?: Record<string, unknown>) => void
}

export interface AnonSubmitResult {
  response: AnonReportResponse
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
      const human = await deps.abuseChecks.verifyTurnstile(input.turnstileToken, ctx.ip ?? "", {
        action: ANON_TURNSTILE_ACTION,
      })
      if (!human) {
        throw AppError.turnstileFailed()
      }

      if (honeypotTripped(input.honeypot)) {
        if (input.anonToken) {
          const presentedId = verifyAnonTokenSignature(input.anonToken, deps.anonTokenSigningKey)
          if (presentedId) {
            await raiseAbuseFlag("anon_token", presentedId, "honeypot").catch((err) => {
              log("anon-submit: honeypot raiseAbuseFlag failed (non-fatal)", { err: String(err) })
            })
          }
        }
        log("anon-submit: honeypot tripped; rejecting", { ip: ctx.ip })
        throw AppError.validation({ description: "Please review your report and try again." })
      }

      const presentedToken = await resolveAnonToken(input.anonToken, tokenDeps)

      const existing = await deps.repo.findIdempotentSnapshot(
        input.idempotencyKey,
        ANON_REPORT_CREATE_SCOPE,
        presentedToken?.id ?? null,
      )
      if (existing) {
        return { response: existing }
      }

      if (input.mediaUploadIds.length > ANON_MAX_MEDIA_UPLOADS) {
        throw AppError.validation({ mediaUploadIds: "Too many media uploads." })
      }

      assertNoSlur(input.title ?? null, "title")
      assertNoSlur(input.description ?? null, "description")

      await enforceIpRateLimit(ctx.ip, { counters: deps.counters })

      await enforceH3CellCap(input.lat, input.lng, { counters: deps.counters })

      const ipGeo = resolveTrustedCfGeo(ctx, log)
      const gps = await gpsSanityCheck(
        { point: { lat: input.lat, lng: input.lng }, ipGeo },
        { abuseChecks: deps.abuseChecks, log },
      )
      if (!gps.ok) {
        throw AppError.gpsImplausible()
      }

      const { record: tokenRow, issuedToken } = await ensureAnonToken(presentedToken, tokenDeps)

      const suppliedAddr = input.addr?.trim()
      const [jurisdictionGeoid, geocodedAddr] = await Promise.all([
        deps.resolveJurisdictionGeoid(input.lat, input.lng),
        suppliedAddr || !deps.reverseGeocode
          ? Promise.resolve(null)
          : deps.reverseGeocode(input.lat, input.lng),
      ])
      const jurCode =
        deps.resolveJurisdictionCode !== undefined
          ? await deps.resolveJurisdictionCode(jurisdictionGeoid)
          : UNKNOWN_JURCODE
      const h3Cell = reportH3Cell(input.lat, input.lng)
      const reportId = newId()
      const claimCode = newClaimCode()
      const claimCodeHash = await sha256Hex(claimCode)
      const addr = suppliedAddr ? suppliedAddr : geocodedAddr

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
        jurCode,
        category: REPORT_TYPE_TO_CATEGORY[input.type],
        type: input.type,
        title: input.title ?? null,
        description: input.description ?? null,
        addr,
        h3Cell,
        mediaUploadIds: input.mediaUploadIds,
        claimCodeHash,
        reportCap: ANON_TOKEN_REPORT_CAP,
        responseSnapshot,
      })

      if (result.kind === "created" && input.mediaUploadIds.length > 0) {
        await enqueueMediaChecks(reportId, input.mediaUploadIds).catch((err) => {
          log("anon-submit: media.checks enqueue failed (non-fatal)", {
            reportId,
            err: String(err),
          })
        })
      }

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
      if (!row || row.claimCodeHash === null) {
        throw AppError.notFound("Report not found")
      }
      if (!constantTimeStringEqual(row.claimCodeHash, await sha256Hex(claimCode))) {
        throw AppError.notFound("Report not found")
      }
      return {
        status: row.status,
        ...(row.publishedAt !== null ? { publishedAt: row.publishedAt.toISOString() } : {}),
      }
    },
  }
}

function resolveTrustedCfGeo(
  ctx: AnonSubmitContext,
  log: (line: string, extra?: Record<string, unknown>) => void,
): LatLng | null {
  if (!ctx.cfGeo) return null
  if (!ctx.cfGeoTrusted) {
    const parsed = parseCfGeo(ctx.cfGeo)
    if (parsed !== null) {
      log("gps-sanity: ignoring CF geo headers from an untrusted source (fail-open to no_signal)", {
        ip: ctx.ip,
      })
    }
    return null
  }
  return parseCfGeo(ctx.cfGeo)
}
