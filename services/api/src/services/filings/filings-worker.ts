/**
 * The filer's only entry into the API's filing layer (package export "@civfix/api/filings-worker"): queue
 * names and options, job payloads, and the reads and the claim a run needs. Nothing here writes a report,
 * sends a notification or touches Fastify; the filer reports every outcome back through `filing.result`,
 * which the API applies.
 */

import { FilingEvidenceKindSchema, FilingReasonSchema } from "@civfix/contract"
import { z } from "zod"
import type { Sql } from "../../db/client.js"
import type { FilingSettingsRecord, RunningFiling } from "./filing-types.js"

export {
  FILING_CITY_UPDATE_JOB,
  FILING_CLASSIFY_JOB,
  FILING_EMAIL_JOB,
  FILING_QUEUE_OPTIONS,
  FILING_RESULT_JOB,
  FILING_RUN_JOB,
  FILING_SWEEP_JOB,
  SHARED_QUEUE_POLICY,
  type FilingQueueName,
  type FilingQueueOptions,
} from "../../lib/queue-names.js"
export type { FilingSettingsRecord, RunningFiling } from "./filing-types.js"

export interface FilingEmailJobData {
  filingId: string
}

export interface FilingRunJobData {
  filingId: string
  attempt: number
}

const EVIDENCE_LABEL_MAX = 120
const EVIDENCE_MAX = 50

/** The D6 reasons a run ends on at once, with no retry. */
export const IMMEDIATE_NEEDS_HUMAN_REASONS = [
  "captcha",
  "login_required",
  "missing_info",
  "no_route",
  "route_disabled",
  "manual_route",
  "filing_off",
  "dry_run",
] as const

export const FAILED_RUN_REASONS = ["portal_error", "ai_unavailable", "uncertain_submission"] as const

const FilingResultEvidenceSchema = z
  .object({
    r2Key: z.string().min(1),
    kind: FilingEvidenceKindSchema,
    label: z.string().max(EVIDENCE_LABEL_MAX),
  })
  .strict()

/** A filer run's outcome, sent on `filing.result` and applied by the API (D7). */
export const FilingResultPayloadSchema = z
  .object({
    filingId: z.uuid(),
    runId: z.uuid(),
    attempt: z.number().int().positive(),
    outcome: z.enum(["submitted", "linked_existing", "needs_human", "failed", "cancelled"]),
    reason: FilingReasonSchema.optional(),
    reasonDetail: z.string().optional(),
    caseId: z.string().optional(),
    caseUrl: z.string().optional(),
    scriptVersion: z.string().optional(),
    dryRun: z.boolean(),
    evidence: z.array(FilingResultEvidenceSchema).max(EVIDENCE_MAX),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const allowed: readonly string[] | null =
      payload.outcome === "needs_human"
        ? IMMEDIATE_NEEDS_HUMAN_REASONS
        : payload.outcome === "failed"
          ? FAILED_RUN_REASONS
          : null
    if (allowed !== null && (payload.reason === undefined || !allowed.includes(payload.reason))) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: `A ${payload.outcome} result needs one of: ${allowed.join(", ")}`,
      })
    }
  })
export type FilingResultPayload = z.infer<typeof FilingResultPayloadSchema>

export interface FilingRunPhoto {
  servedKey: string
  byteSize: number | null
}

/** What a portal run files: the ticket, where, what, and up to five photos (D3). */
export interface FilingRunPacket {
  filingId: string
  ticketText: string
  addr: string | null
  lat: number
  lng: number
  category: string
  formUrl: string | null
  portalHost: string | null
  requestTypeHint: string | null
  photos: FilingRunPhoto[]
}

export interface FilingsWorker {
  /** Null when the filing does not exist. */
  loadRunPacket(filingId: string): Promise<FilingRunPacket | null>
  getFilingSettings(): Promise<FilingSettingsRecord>
  /** The atomic queued -> running claim for that attempt; null when the job is stale. */
  claimFiling(filingId: string, attempt: number): Promise<{ runId: string } | null>
  listRunningFilings(): Promise<RunningFiling[]>
}

export function makeFilingsWorker(_sql: Sql): FilingsWorker {
  throw new Error("not implemented")
}
