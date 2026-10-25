import { AppError, FILING_CASE_ID_PATTERN } from "@civfix/contract"
import type { FastifyBaseLogger } from "fastify"
import { MS_PER_HOUR, MS_PER_MINUTE } from "../../lib/time.js"
import type { FilingRepository } from "./filing-repository.js"
import type { ApplyFilingSuccessInput } from "./filing-service.js"
import type { FilingMutableFields, FilingReason, FilingRecord } from "./filing-types.js"
import { FilingResultPayloadSchema, type FilingResultPayload } from "./filings-worker.js"

const REASON_DETAIL_MAX = 500
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS: Readonly<Record<number, number>> = {
  1: 10 * MS_PER_MINUTE,
  2: 30 * MS_PER_MINUTE,
}
const AI_RETRY_DELAY_MS = 30 * MS_PER_MINUTE
const AI_WAIT_LIMIT_MS = 6 * MS_PER_HOUR

const UNUSABLE_LINKED_CASE_DETAIL =
  "The portal showed an existing request, but its number was not usable"

export interface FilingResultDeps {
  filings: Pick<FilingRepository, "getById" | "transition">
  applyFilingSuccess(input: ApplyFilingSuccessInput): Promise<{ applied: boolean }>
  enqueueFiling(filing: FilingRecord): Promise<boolean>
  logger?: Pick<FastifyBaseLogger, "warn">
  now: () => Date
}

function parsePayload(raw: unknown): FilingResultPayload {
  const parsed = FilingResultPayloadSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  const fields: Record<string, string> = {}
  for (const issue of parsed.error.issues) {
    fields[issue.path.length > 0 ? issue.path.join(".") : "_"] = issue.message
  }
  throw AppError.validation(fields, "Invalid filing result")
}

/**
 * Kept only on the portal's own host over https: a shared suffix would admit any tenant of the same
 * ServiceNow or Salesforce cloud, and the URL is shown to residents as the city's status page (D7).
 */
function portalCaseUrl(caseUrl: string, portalHost: string | null): string | null {
  let url: URL
  try {
    url = new URL(caseUrl)
  } catch {
    return null
  }
  return url.protocol === "https:" && portalHost !== null && url.hostname === portalHost
    ? caseUrl
    : null
}

function detail(payload: FilingResultPayload): Partial<FilingMutableFields> {
  return payload.reasonDetail === undefined
    ? {}
    : { reasonDetail: payload.reasonDetail.slice(0, REASON_DETAIL_MAX) }
}

/**
 * Applies a filer run's outcome (D6, D7). Every write is guarded on the run's attempt while the filing
 * is still running, so a redelivered or stale result matches no row and changes nothing.
 */
export function makeApplyFilingResult(
  deps: FilingResultDeps,
): (raw: unknown) => Promise<{ applied: boolean }> {
  async function guarded(
    filing: FilingRecord,
    payload: FilingResultPayload,
    set: Partial<FilingMutableFields>,
  ): Promise<FilingRecord | null> {
    return deps.filings.transition(filing.id, {
      from: ["running"],
      attempts: payload.attempt,
      set: {
        ...set,
        dryRun: payload.dryRun,
        ...(payload.scriptVersion !== undefined ? { scriptVersion: payload.scriptVersion } : {}),
      },
      evidence: payload.evidence,
    })
  }

  function needsHuman(
    filing: FilingRecord,
    payload: FilingResultPayload,
    reason: FilingReason,
    extra: Partial<FilingMutableFields> = detail(payload),
  ): Promise<FilingRecord | null> {
    return guarded(filing, payload, { status: "needs_human", reason, ...extra })
  }

  async function requeue(
    filing: FilingRecord,
    payload: FilingResultPayload,
    set: Partial<FilingMutableFields>,
  ): Promise<boolean> {
    const queued = await guarded(filing, payload, { status: "queued", ...set })
    if (queued === null) return false
    await deps.enqueueFiling(queued)
    return true
  }

  async function success(
    filing: FilingRecord,
    payload: FilingResultPayload & { outcome: "submitted" | "linked_existing" },
  ): Promise<boolean> {
    const caseId = payload.caseId
    const caseIdOk = caseId === undefined || FILING_CASE_ID_PATTERN.test(caseId)
    if (payload.outcome === "submitted" && !caseIdOk) {
      // The bad id came after the submit click, so the city may well have the request.
      return (await needsHuman(filing, payload, "uncertain_submission")) !== null
    }
    if (payload.outcome === "linked_existing" && (caseId === undefined || !caseIdOk)) {
      return (
        (await needsHuman(filing, payload, "other", {
          reasonDetail: UNUSABLE_LINKED_CASE_DETAIL,
        })) !== null
      )
    }
    const { applied } = await deps.applyFilingSuccess({
      filingId: filing.id,
      from: { status: ["running"], attempts: payload.attempt },
      outcome: payload.outcome,
      method: "script",
      ...(caseId !== undefined ? { caseId } : {}),
      ...(payload.caseUrl !== undefined
        ? { caseUrl: portalCaseUrl(payload.caseUrl, filing.portalHost) }
        : {}),
      dryRun: payload.dryRun,
      ...(payload.scriptVersion !== undefined ? { scriptVersion: payload.scriptVersion } : {}),
      evidence: payload.evidence,
    })
    return applied
  }

  async function failed(filing: FilingRecord, payload: FilingResultPayload): Promise<boolean> {
    const now = deps.now()
    const n = payload.attempt
    switch (payload.reason) {
      case "portal_error": {
        const delay = RETRY_DELAY_MS[n]
        if (n >= MAX_ATTEMPTS || delay === undefined) {
          return (await needsHuman(filing, payload, "attempts_exhausted")) !== null
        }
        return requeue(filing, payload, { nextAttemptAt: new Date(now.getTime() + delay) })
      }
      case "ai_unavailable": {
        const waitingSince = filing.aiWaitSince ?? now
        if (now.getTime() - waitingSince.getTime() >= AI_WAIT_LIMIT_MS) {
          return (await needsHuman(filing, payload, "ai_unavailable")) !== null
        }
        // Waiting on Claude is not the portal's fault, so it spends no attempt.
        return requeue(filing, payload, {
          attempts: n - 1,
          nextAttemptAt: new Date(now.getTime() + AI_RETRY_DELAY_MS),
          aiWaitSince: waitingSince,
        })
      }
      default:
        return (await needsHuman(filing, payload, "uncertain_submission")) !== null
    }
  }

  async function apply(filing: FilingRecord, payload: FilingResultPayload): Promise<boolean> {
    switch (payload.outcome) {
      case "submitted":
      case "linked_existing":
        return success(filing, { ...payload, outcome: payload.outcome })
      case "needs_human":
        return (await needsHuman(filing, payload, payload.reason ?? "other")) !== null
      case "failed":
        return failed(filing, payload)
      case "cancelled":
        return (await guarded(filing, payload, { status: "cancelled" })) !== null
    }
  }

  return async (raw) => {
    const payload = parsePayload(raw)
    const filing = await deps.filings.getById(payload.filingId)
    // A requeue that spends no attempt (ai_unavailable) gives the next run the same attempt number, so
    // only the run id tells its result from a late one of the run before. filing.result is worked one
    // job at a time, so nothing moves the filing to another run between this read and the guarded write.
    const applied =
      filing !== null && filing.runId === payload.runId && (await apply(filing, payload))
    if (!applied) {
      deps.logger?.warn(
        { filingId: payload.filingId, runId: payload.runId, attempt: payload.attempt },
        "filing result matched no running filing at that attempt; ignored",
      )
    }
    return { applied }
  }
}
