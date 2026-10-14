import { randomUUID } from "node:crypto"
import { AppError, REPORT_TYPE_TO_CATEGORY } from "@civfix/shared"
import type {
  AnonReportRequest,
  AnonReportResponse,
  AnonReportStatusResponse,
  LatLng,
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
} from "../abuse/anon-token.js"
import { generateToken, constantTimeStringEqual, sha256Hex } from "../auth/crypto.js"
import { UNKNOWN_JURCODE } from "../db/reference-code.js"
import { UNSESSIONED_UPLOADER, anonUploader } from "./media-uploader.js"
import {
  addressProvenance,
  resolveAddressOrNull,
  type AddressResolver,
  type ReportAddressWrite,
} from "./address-resolver.js"
import type { AnonReportRepository } from "./anon-repository.js"

export const ANON_REPORT_CREATE_SCOPE = "anon_report_create"

export const ANON_TURNSTILE_ACTION = "anon-report"

export const ANON_MAX_MEDIA_UPLOADS = 5

const HONEYPOT_REJECTION_MESSAGE = "Please review your report and try again."

const REPORT_NOT_FOUND_MESSAGE = "Report not found"

export type AnonLog = (line: string, extra?: Record<string, unknown>) => void

export type AnonAbuseReason = "honeypot" | "gps"

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
  /** Structured twin of the signed-in path's dep - same resolver, same cache, same provenance rules. */
  resolveAddress?: AddressResolver
  raiseAbuseFlag?: (
    subjectType: "report" | "anon_token",
    subjectId: string,
    reason: AnonAbuseReason,
  ) => Promise<void>
  newId?: () => string
  newClaimCode?: () => string
  now?: () => Date
  newAnonTokenId?: () => string
  log?: AnonLog
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

  const tokenDeps: AnonTokenDeps = {
    store: deps.repo,
    signingKey: deps.anonTokenSigningKey,
    now,
    ...(deps.newAnonTokenId !== undefined ? { newId: deps.newAnonTokenId } : {}),
  }

  async function rejectBots(input: AnonReportRequest, ctx: AnonSubmitContext): Promise<void> {
    const human = await deps.abuseChecks.verifyTurnstile(input.turnstileToken, ctx.ip ?? "", {
      action: ANON_TURNSTILE_ACTION,
    })
    if (!human) {
      throw AppError.turnstileFailed()
    }

    if (!honeypotTripped(input.honeypot)) return
    const presentedId = input.anonToken
      ? verifyAnonTokenSignature(input.anonToken, deps.anonTokenSigningKey)
      : null
    if (presentedId) {
      await raiseAbuseFlag("anon_token", presentedId, "honeypot").catch((err) => {
        log("anon-submit: honeypot raiseAbuseFlag failed (non-fatal)", { err: String(err) })
      })
    }
    log("anon-submit: honeypot tripped; rejecting", { ip: ctx.ip })
    throw AppError.validation({ description: HONEYPOT_REJECTION_MESSAGE })
  }

  async function enforceContentAndQuotas(
    input: AnonReportRequest,
    ctx: AnonSubmitContext,
  ): Promise<void> {
    if (input.mediaUploadIds.length > ANON_MAX_MEDIA_UPLOADS) {
      throw AppError.validation({ mediaUploadIds: "Too many media uploads." })
    }

    assertNoSlur(input.title ?? null, "title")
    assertNoSlur(input.description ?? null, "description")
    assertNoSlur(input.addr ?? null, "addr")

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
  }

  async function resolveLocation(input: AnonReportRequest): Promise<{
    jurisdictionGeoid: string | null
    jurCode: number
    addressWrite: ReportAddressWrite
  }> {
    const suppliedAddr = input.addr?.trim() ?? ""
    const [jurisdictionGeoid, resolvedAddr] = await Promise.all([
      deps.resolveJurisdictionGeoid(input.lat, input.lng),
      suppliedAddr.length > 0
        ? Promise.resolve(null)
        : resolveAddressOrNull(deps.resolveAddress, input.lat, input.lng),
    ])
    const jurCode =
      deps.resolveJurisdictionCode !== undefined
        ? await deps.resolveJurisdictionCode(jurisdictionGeoid)
        : UNKNOWN_JURCODE
    return {
      jurisdictionGeoid,
      jurCode,
      addressWrite: addressProvenance(suppliedAddr, resolvedAddr),
    }
  }

  return {
    async submitAnonReport(
      input: AnonReportRequest,
      ctx: AnonSubmitContext,
    ): Promise<AnonSubmitResult> {
      await rejectBots(input, ctx)

      const presentedToken = await resolveAnonToken(input.anonToken, tokenDeps)

      const existing = await deps.repo.findIdempotentSnapshot(
        input.idempotencyKey,
        ANON_REPORT_CREATE_SCOPE,
        presentedToken?.id ?? null,
      )
      if (existing) {
        return { response: existing }
      }

      await enforceContentAndQuotas(input, ctx)

      const { record: tokenRow, issuedToken } = await ensureAnonToken(presentedToken, tokenDeps)

      const { jurisdictionGeoid, jurCode, addressWrite } = await resolveLocation(input)
      const h3Cell = reportH3Cell(input.lat, input.lng)
      const reportId = newId()
      const claimCode = newClaimCode()
      const claimCodeHash = await sha256Hex(claimCode)

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
        addr: addressWrite.addr,
        addrSource: addressWrite.addrSource,
        addrPrecision: addressWrite.addrPrecision,
        h3Cell,
        mediaUploadIds: input.mediaUploadIds,
        mediaUploaders: anonMediaUploaders(tokenRow.id, input.anonToken, deps.anonTokenSigningKey),
        claimCodeHash,
        reportCap: ANON_TOKEN_REPORT_CAP,
        responseSnapshot,
      })

      return {
        response: result.snapshot,
        ...(result.kind === "created" && issuedToken !== undefined
          ? { issuedAnonToken: issuedToken }
          : {}),
      }
    },

    async anonReportStatus(reportId: string, claimCode: string): Promise<AnonReportStatusResponse> {
      const row = await deps.repo.findAnonReportStatus(reportId)
      if (!row || row.claimCodeHash === null) {
        throw AppError.notFound(REPORT_NOT_FOUND_MESSAGE)
      }
      if (!constantTimeStringEqual(row.claimCodeHash, await sha256Hex(claimCode))) {
        throw AppError.notFound(REPORT_NOT_FOUND_MESSAGE)
      }
      return {
        status: row.status,
        ...(row.publishedAt !== null ? { publishedAt: row.publishedAt.toISOString() } : {}),
      }
    },
  }
}

// Guest uploads carry the anon cookie the upload request presented, and a first report's uploads carry no
// session at all. The presented token counts by signature alone: an expired one is re-issued at submit,
// yet the uploads made under it are still this guest's.
function anonMediaUploaders(
  tokenId: string,
  presentedToken: string | undefined,
  signingKey: string,
): string[] {
  const presentedId = presentedToken ? verifyAnonTokenSignature(presentedToken, signingKey) : null
  const sessions =
    presentedId !== null && presentedId !== tokenId ? [tokenId, presentedId] : [tokenId]
  return [...sessions.map(anonUploader), UNSESSIONED_UPLOADER]
}

function resolveTrustedCfGeo(ctx: AnonSubmitContext, log: AnonLog): LatLng | null {
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
