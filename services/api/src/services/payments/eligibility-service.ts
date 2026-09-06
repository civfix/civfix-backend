import { createHash } from "node:crypto"
import { AppError } from "@civfix/shared"
import type { Jobs, Storage } from "@civfix/shared/interfaces"
import {
  REVIEW_REQUIRED_BLOCKS_DONATIONS,
  addBusinessDays,
  evaluateEligibility,
  isDonationEligible,
} from "@civfix/shared/payments"
import type {
  EinSourceValue,
  EligibilitySourceValue,
  EligibilityVerdictValue,
} from "../../db/schema/types-payments.js"
import type {
  AppendCheckInput,
  BmfListingInput,
  EligibilityRepository,
  EvidenceSnapshot,
} from "./eligibility-repository.drizzle.js"
import type { OrgPaymentsRepository } from "./org-payments-repository.drizzle.js"
import {
  ELIGIBILITY_SOURCES,
  IMPORTABLE_SOURCES,
  complianceObjectKey,
  complianceObjectPrefix,
  normalizeEin,
  normalizeOrgName,
  revisionFromHeaders,
  type EligibilitySourceSpec,
} from "./eligibility-sources.js"
import {
  assertSanityFloor,
  indexTargets,
  scanRevision,
  type RevisionPart,
  type ScanHit,
  type ScreeningTarget,
} from "./eligibility-scan.js"
import { ELIGIBILITY_EVALUATE_JOB, PAYMENTS_JOB_RETRY_LIMIT } from "./payments-queues.js"

export const ELIGIBILITY_IMPORT_TIMEOUT_MS = 120_000

export const ELIGIBILITY_HEAD_TIMEOUT_MS = 15_000

export const ELIGIBILITY_ORG_PAGE = 500

export const ELIGIBILITY_RECHECK_DAYS = 30

export const MAX_HIT_DETAILS = 3

export interface EligibilityImportResult {
  source: EligibilitySourceValue
  revision: string
  skipped: boolean
  rowCount: number
  matchedCount: number
  organizationsTouched: string[]
}

export interface EligibilityScreeningResult {
  screened: EligibilitySourceValue[]
  skipped: EligibilitySourceValue[]
  errors: { source: EligibilitySourceValue; message: string }[]
}

export interface EligibilityEvaluation {
  verdict: EligibilityVerdictValue
  previous: EligibilityVerdictValue | null
  reasons: string[]
  graceExpiresAt: Date | null
  screening: EligibilityScreeningResult | null
}

export class EligibilityScreeningError extends Error {
  readonly organizationId: string
  readonly failures: { source: EligibilitySourceValue; message: string }[]

  constructor(organizationId: string, failures: { source: EligibilitySourceValue; message: string }[]) {
    super(
      `eligibility screening for ${organizationId} failed for ${failures.map((f) => f.source).join(", ")}`,
    )
    this.name = "EligibilityScreeningError"
    this.organizationId = organizationId
    this.failures = failures
  }
}

export interface EligibilityServiceDeps {
  eligibility: EligibilityRepository
  orgs: OrgPaymentsRepository
  storage: Storage
  jobs?: Jobs
  fetchImpl?: typeof fetch
  now?: () => Date
  reviewRequiredBlocks?: boolean
  sources?: Partial<Record<EligibilitySourceValue, EligibilitySourceSpec>>
  logger?: { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void }
}

export interface EligibilityService {
  importSource(source: EligibilitySourceValue): Promise<EligibilityImportResult>
  screenOrganization(organizationId: string): Promise<EligibilityScreeningResult>
  evaluate(organizationId: string, options?: { screen?: boolean }): Promise<EligibilityEvaluation>
  setEin(input: {
    organizationId: string
    ein: string
    source: EinSourceValue
    actorUserId: string | null
  }): Promise<{ ein: string; changed: boolean; queued: boolean }>
  setCentralOrgConfirmation(input: {
    organizationId: string
    confirmed: boolean
    actorUserId: string
    note: string | null
  }): Promise<{ centralOrgConfirmedAt: Date | null; queued: boolean }>
  requestEvaluation(organizationId: string): Promise<boolean>
}

interface FetchedPart {
  bytes: Uint8Array
  sha256: string
  headers: Headers
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function retentionFrom(stamped: Date, years: number): Date {
  const until = new Date(stamped)
  until.setUTCFullYear(until.getUTCFullYear() + years)
  return until
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function compositeSha(parts: readonly RevisionPart[]): string {
  if (parts.length === 1) return (parts[0] as RevisionPart).sha256
  const digest = createHash("sha256")
  for (const part of parts) digest.update(part.sha256)
  return digest.digest("hex")
}

function hitDetail(hits: readonly ScanHit[]): string | null {
  const details = hits
    .map((hit) => hit.row.detail)
    .filter((detail): detail is string => detail !== null)
    .slice(0, MAX_HIT_DETAILS)
  return details.length === 0 ? null : details.join(" | ")
}

function screenedNamesDetail(target: ScreeningTarget): string {
  const names = [...new Set([normalizeOrgName(target.irsLegalName), normalizeOrgName(target.orgName)])]
    .filter((name) => name.length > 0)
  return `screened=${names.join(";")}`
}

function bmfListingsFor(
  hits: Map<string, ScanHit[]>,
  targets: readonly ScreeningTarget[],
  stamped: Date,
): BmfListingInput[] {
  const listings: BmfListingInput[] = []
  for (const target of targets) {
    const row = hits.get(target.organizationId)?.[0]?.row
    if (row === undefined || row.address === null) continue
    listings.push({
      organizationId: target.organizationId,
      ein: target.ein,
      irsAddress: row.address,
      groupExemptionSubordinate: row.groupExemptionSubordinate === true,
      now: stamped,
    })
  }
  return listings
}

function checkRowsFor(input: {
  spec: EligibilitySourceSpec
  target: ScreeningTarget
  hits: readonly ScanHit[] | undefined
  revision: string
  revisionSha256: string
  revisionKey: string
  checkedAt: Date
  retentionUntil: Date
}): AppendCheckInput {
  const { spec, target, hits } = input
  if (hits === undefined || hits.length === 0) {
    return {
      organizationId: target.organizationId,
      source: spec.source,
      ein: target.ein,
      irsLegalName: null,
      foundationCode: null,
      deductibilityCode: null,
      sourceRevisionDate: input.revision,
      rawReportSha256: input.revisionSha256,
      rawReportKey: input.revisionKey,
      matched: false,
      verdictContribution: "neutral",
      detail: spec.matchOn === "name" ? screenedNamesDetail(target) : null,
      checkedAt: input.checkedAt,
      retentionUntil: input.retentionUntil,
    }
  }
  const first = hits[0] as ScanHit
  const disqualifies =
    spec.contribution === "disqualifies" && hits.some((hit) => hit.row.disqualifies)
  const contribution =
    spec.contribution === "disqualifies"
      ? disqualifies
        ? "disqualifies"
        : "neutral"
      : spec.contribution
  return {
    organizationId: target.organizationId,
    source: spec.source,
    ein: target.ein,
    irsLegalName: spec.matchOn === "ein" ? first.row.name : null,
    foundationCode: first.row.foundationCode,
    deductibilityCode: first.row.deductibilityCode,
    sourceRevisionDate: input.revision,
    rawReportSha256: first.partSha256,
    rawReportKey: first.partKey,
    matched: true,
    verdictContribution: contribution,
    detail: hitDetail(hits),
    checkedAt: input.checkedAt,
    retentionUntil: input.retentionUntil,
  }
}

export function makeEligibilityService(deps: EligibilityServiceDeps): EligibilityService {
  const now = deps.now ?? (() => new Date())
  const doFetch = deps.fetchImpl ?? globalThis.fetch
  const reviewRequiredBlocks = deps.reviewRequiredBlocks ?? REVIEW_REQUIRED_BLOCKS_DONATIONS
  const specs: Record<EligibilitySourceValue, EligibilitySourceSpec> = {
    ...ELIGIBILITY_SOURCES,
    ...(deps.sources ?? {}),
  }

  async function declaredSize(url: string): Promise<number | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ELIGIBILITY_HEAD_TIMEOUT_MS)
    try {
      const response = await doFetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
      })
      if (!response.ok) return null
      const declared = Number(response.headers.get("content-length"))
      return Number.isFinite(declared) && declared > 0 ? declared : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async function fetchPart(url: string, maxBytes: number): Promise<FetchedPart> {
    const declared = await declaredSize(url)
    if (declared === null || declared * 2 > maxBytes) {
      deps.logger?.warn(
        { url, declaredBytes: declared, maxBytes },
        "eligibility import: source size approaching (or unknown against) the per-source ceiling",
      )
    }
    if (declared !== null && declared > maxBytes) {
      throw new Error(
        `eligibility import: ${url} declares ${declared} bytes, over the ${maxBytes} byte ceiling for this source`,
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ELIGIBILITY_IMPORT_TIMEOUT_MS)
    try {
      const response = await doFetch(url, { redirect: "follow", signal: controller.signal })
      if (!response.ok || response.body === null) {
        throw new Error(`eligibility import: HTTP ${response.status} from ${url}`)
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let byteLength = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value === undefined) continue
          byteLength += value.byteLength
          if (byteLength > maxBytes) {
            throw new Error(`eligibility import: ${url} exceeded the archive ceiling`)
          }
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      const bytes = new Uint8Array(byteLength)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return { bytes, sha256: sha256Of(bytes), headers: response.headers }
    } finally {
      clearTimeout(timer)
    }
  }

  async function allTargets(): Promise<ScreeningTarget[]> {
    const targets: ScreeningTarget[] = []
    let after: string | null = null
    for (;;) {
      const page = await deps.eligibility.listScreeningTargets(ELIGIBILITY_ORG_PAGE, after)
      targets.push(...page)
      const last = page[page.length - 1]
      if (last === undefined || page.length < ELIGIBILITY_ORG_PAGE) break
      after = last.organizationId
    }
    return targets
  }

  async function archivedParts(
    source: EligibilitySourceValue,
    revision: string,
  ): Promise<RevisionPart[]> {
    const prefix = complianceObjectPrefix(source, revision)
    const listed = await deps.storage.list(prefix)
    const keys = listed.keys.filter((key) => key === `${prefix}.raw` || key.startsWith(`${prefix}.part`))
    if (keys.length === 0) throw new Error(`archived revision ${prefix} is missing`)
    const parts: RevisionPart[] = []
    for (const key of keys.sort()) {
      const bytes = await deps.storage.getObject(key)
      if (bytes === null) throw new Error(`archived object ${key} is missing`)
      parts.push({ key, sha256: sha256Of(bytes), bytes })
    }
    return parts
  }

  async function requestEvaluation(organizationId: string): Promise<boolean> {
    if (deps.jobs === undefined) return false
    await deps.jobs.enqueue(
      ELIGIBILITY_EVALUATE_JOB,
      { organizationId },
      { singletonKey: `eligibility:${organizationId}`, retryLimit: PAYMENTS_JOB_RETRY_LIMIT },
    )
    return true
  }

  async function screen(
    organizationId: string,
    evidence: EvidenceSnapshot,
  ): Promise<EligibilityScreeningResult> {
    const result: EligibilityScreeningResult = { screened: [], skipped: [], errors: [] }
    const target = await deps.eligibility.screeningTarget(organizationId)
    if (target === null) return result
    const index = indexTargets([target])
    const stamped = now()

    for (const source of IMPORTABLE_SOURCES) {
      const spec = specs[source]
      try {
        const latest = await deps.eligibility.latestRevision(source)
        if (latest === null || evidence.sourceRevisions[source] === latest.sourceRevisionDate) {
          result.skipped.push(source)
          continue
        }
        const parts = await archivedParts(source, latest.sourceRevisionDate)
        const outcome = await scanRevision(spec, parts, index)
        assertSanityFloor(spec, outcome)
        const hits = outcome.hits
        await deps.eligibility.appendChecks(
          [
            checkRowsFor({
              spec,
              target,
              hits: hits.get(target.organizationId),
              revision: latest.sourceRevisionDate,
              revisionSha256: latest.sha256,
              revisionKey: latest.r2Key,
              checkedAt: stamped,
              retentionUntil: retentionFrom(stamped, spec.retentionYears),
            }),
          ],
          source === "irs_eo_bmf" ? bmfListingsFor(hits, [target], stamped) : [],
        )
        result.screened.push(source)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        deps.logger?.error(
          { evt: "eligibility.screen.failed", organizationId, source, err: message },
          "eligibility screening against the archived revision failed",
        )
        result.errors.push({ source, message })
      }
    }
    return result
  }

  return {
    async importSource(source) {
      const spec = specs[source]
      if (spec.urls.length === 0) {
        throw new Error(`eligibility import ${source}: source is not importable`)
      }
      const stamped = now()
      const fetched: FetchedPart[] = []
      for (const url of spec.urls) fetched.push(await fetchPart(url, spec.maxBytesPerPart))

      const revision = fetched
        .map((part) => revisionFromHeaders(part.headers, stamped))
        .sort()
        .reverse()[0] as string

      if (await deps.eligibility.knownRevision(source, revision)) {
        return {
          source,
          revision,
          skipped: true,
          rowCount: 0,
          matchedCount: 0,
          organizationsTouched: [],
        }
      }

      const parts: RevisionPart[] = fetched.map((part, position) => ({
        key: complianceObjectKey(source, revision, fetched.length === 1 ? null : position + 1),
        sha256: part.sha256,
        bytes: part.bytes,
      }))
      const targets = await allTargets()
      const index = indexTargets(targets)

      const outcome = await scanRevision(spec, parts, index)
      const prior = await deps.eligibility.latestRevision(source)
      assertSanityFloor(spec, outcome, prior?.rowCount ?? null)

      const revisionSha256 = compositeSha(parts)
      const revisionKey =
        parts.length === 1 ? (parts[0] as RevisionPart).key : complianceObjectPrefix(source, revision)
      const retentionUntil = retentionFrom(stamped, spec.retentionYears)
      const contentType = spec.container === "zip" ? "application/zip" : "text/csv"
      for (const part of parts) await deps.storage.put(part.key, part.bytes, { contentType })

      const checks = targets.map((target) =>
        checkRowsFor({
          spec,
          target,
          hits: outcome.hits.get(target.organizationId),
          revision,
          revisionSha256,
          revisionKey,
          checkedAt: stamped,
          retentionUntil,
        }),
      )
      const matchedCount = checks.filter((check) => check.matched).length

      await deps.eligibility.appendRevision(
        {
          source,
          sourceRevisionDate: revision,
          sha256: revisionSha256,
          r2Key: revisionKey,
          rowCount: outcome.rowCount,
          matchedCount,
          retentionUntil,
        },
        checks,
        source === "irs_eo_bmf" ? bmfListingsFor(outcome.hits, targets, stamped) : [],
      )

      return {
        source,
        revision,
        skipped: false,
        rowCount: outcome.rowCount,
        matchedCount,
        organizationsTouched: targets.map((target) => target.organizationId),
      }
    },

    async screenOrganization(organizationId) {
      return screen(organizationId, await deps.eligibility.evidenceFor(organizationId))
    },

    async evaluate(organizationId, options = {}) {
      let evidence = await deps.eligibility.evidenceFor(organizationId)
      let screening: EligibilityScreeningResult | null = null
      if (options.screen ?? true) {
        screening = await screen(organizationId, evidence)
        if (screening.errors.length > 0) {
          throw new EligibilityScreeningError(organizationId, screening.errors)
        }
        if (screening.screened.length > 0) {
          evidence = await deps.eligibility.evidenceFor(organizationId)
        }
      }

      const stamped = now()
      const mnosFirstSeenOn = evidence.mnosListed
        ? (evidence.mnosFirstSeenOn ?? dayOf(stamped))
        : null
      const result = evaluateEligibility({
        pub78Listed: evidence.pub78Listed,
        pub78Checked: evidence.pub78Checked,
        bmfListed: evidence.bmfListed,
        bmfChecked: evidence.bmfChecked,
        deductibilityCode: evidence.deductibilityCode,
        autoRevocationListed: evidence.autoRevocationListed,
        ftbRevoked: evidence.ftbRevoked,
        mnosListed: evidence.mnosListed,
        ofacMatch: evidence.ofacMatch,
        groupExemptionSubordinate: evidence.groupExemptionSubordinate,
        centralOrgConfirmed: evidence.centralOrgConfirmed,
        mnosFirstSeenOn,
        asOf: dayOf(stamped),
      })

      const graceExpiresAt =
        result.graceExpiresOn === null ? null : new Date(`${result.graceExpiresOn}T23:59:59.999Z`)
      const nextCheckAt = new Date(stamped.getTime() + ELIGIBILITY_RECHECK_DAYS * 86400_000)

      const previous = await deps.eligibility.applyVerdict({
        organizationId,
        verdict: result.verdict,
        reasons: result.reasons,
        contributionsDeductible: result.contributionsDeductible,
        graceExpiresAt,
        mnosFirstSeenOn,
        irsLegalName: evidence.irsLegalName,
        foundationCode: evidence.foundationCode,
        deductibilityCode: evidence.deductibilityCode,
        evaluatedAt: stamped,
        nextCheckAt,
      })

      const view = await deps.orgs.paymentsView(organizationId)
      const settings = view?.settings ?? null
      const permitted = isDonationEligible(result, { reviewRequiredBlocks })

      if (!permitted && settings !== null && settings.enabled) {
        await deps.orgs.setDonationsEnabled({
          organizationId,
          enabled: false,
          reason: "eligibility",
          reasonText: null,
          actorUserId: null,
          now: stamped,
        })
      }

      if (
        permitted &&
        settings !== null &&
        !settings.enabled &&
        settings.disabledReason === "eligibility"
      ) {
        await deps.orgs.setDonationsEnabled({
          organizationId,
          enabled: true,
          reason: null,
          reasonText: null,
          actorUserId: null,
          now: stamped,
        })
      }

      return {
        verdict: result.verdict,
        previous,
        reasons: [...result.reasons],
        graceExpiresAt,
        screening,
      }
    },

    async setEin(input) {
      const ein = normalizeEin(input.ein)
      if (ein === null) {
        throw AppError.validation({ ein: "must be a nine-digit EIN" })
      }
      const { changed } = await deps.eligibility.setEin({
        organizationId: input.organizationId,
        ein,
        source: input.source,
        actorUserId: input.actorUserId,
        now: now(),
      })
      const queued = await requestEvaluation(input.organizationId)
      return { ein, changed, queued }
    },

    async setCentralOrgConfirmation(input) {
      const stamped = now()
      const centralOrgConfirmedAt = await deps.eligibility.setCentralOrgConfirmation({
        organizationId: input.organizationId,
        confirmed: input.confirmed,
        actorUserId: input.actorUserId,
        now: stamped,
      })
      const spec = specs.central_org_confirmation
      await deps.eligibility.appendChecks([
        {
          organizationId: input.organizationId,
          source: spec.source,
          ein: null,
          irsLegalName: null,
          foundationCode: null,
          deductibilityCode: null,
          sourceRevisionDate: dayOf(stamped),
          rawReportSha256: null,
          rawReportKey: null,
          matched: input.confirmed,
          verdictContribution: input.confirmed ? "supports" : "neutral",
          detail: input.note,
          checkedAt: stamped,
          retentionUntil: retentionFrom(stamped, spec.retentionYears),
        },
      ])
      const queued = await requestEvaluation(input.organizationId)
      return { centralOrgConfirmedAt, queued }
    },

    requestEvaluation,
  }
}

export { addBusinessDays }
