/**
 * The filer's only entry into the API's filing layer (package export "@civfix/api/filings-worker"): queue
 * names and options, job payloads, and the reads and the claim a run needs. Nothing here writes a report,
 * sends a notification or touches Fastify; the filer reports every outcome back through `filing.result`,
 * which the API applies.
 */

import { FilingEvidenceKindSchema, FilingReasonSchema } from "@civfix/contract"
import { z } from "zod"
import type { Sql } from "../../db/client.js"
import { makeDrizzleFilingRepository } from "./filing-repository.drizzle.js"
import type { FilingRecord, FilingSettingsRecord, RunningFiling } from "./filing-types.js"

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

export const FAILED_RUN_REASONS = [
  "portal_error",
  "ai_unavailable",
  "uncertain_submission",
] as const

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

export const FILING_CLASSIFICATION_STATUSES = [
  "received",
  "in_progress",
  "closed",
  "needs_info",
  "other",
] as const

const CLASSIFICATION_SUMMARY_MAX = 280

/**
 * Claude's reading of a city message (D11). The filer produces it and the API re-validates it on
 * `filing.city_update`, since Claude reads the city's text with the open web in reach.
 */
export const FilingClassificationSchema = z
  .object({
    caseId: z.string().nullable(),
    status: z.enum(FILING_CLASSIFICATION_STATUSES),
    summary: z.string().max(CLASSIFICATION_SUMMARY_MAX),
    confidence: z.number().min(0).max(1),
  })
  .strict()
export type FilingClassification = z.infer<typeof FilingClassificationSchema>

/** `filing.classify`: a trusted city message for Claude to read; `text` is at most 20,000 characters. */
export interface FilingClassifyJobData {
  filingMessageId: string
  subject: string
  text: string
}

/** `filing.city_update`: the classification the API applies to the message's filing. */
export interface FilingCityUpdateJobData {
  filingMessageId: string
  classification: FilingClassification
}

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

const RUN_PHOTOS_MAX = 5

export function makeFilingsWorker(sql: Sql): FilingsWorker {
  const filings = makeDrizzleFilingRepository(sql)

  async function requestTypeHint(filing: FilingRecord): Promise<string | null> {
    if (filing.geoid === null) return null
    const routes = await filings.findRoutes(filing.geoid, filing.category)
    return routes.find((r) => r.category === filing.routeCategory)?.requestTypeHint ?? null
  }

  return {
    async loadRunPacket(filingId) {
      const filing = await filings.getById(filingId)
      if (filing === null) return null
      const [[report], photos, hint] = await Promise.all([
        sql<{ addr: string | null; lat: number; lng: number; category: string }[]>`
          SELECT r.addr, ST_Y(r.geom) AS lat, ST_X(r.geom) AS lng, r.category
          FROM reports r
          WHERE r.id = ${filing.reportId}
        `,
        // The admin's listMedia order (oldest first), images only: a portal never gets a video (D3).
        // byte_size is int8, which postgres-js returns as a string.
        sql<{ served_key: string; byte_size: number | null }[]>`
          SELECT served_key, byte_size::float8 AS byte_size
          FROM media_assets
          WHERE report_id = ${filing.reportId}
            AND kind = 'image' AND status = 'ready' AND served_key IS NOT NULL
          ORDER BY created_at ASC, id ASC
          LIMIT ${RUN_PHOTOS_MAX}
        `,
        requestTypeHint(filing),
      ])
      if (report === undefined) throw new Error(`filing ${filingId}: its report row is missing`)
      return {
        filingId: filing.id,
        ticketText: filing.ticketText,
        addr: report.addr,
        lat: report.lat,
        lng: report.lng,
        category: report.category,
        formUrl: filing.formUrl,
        portalHost: filing.portalHost,
        requestTypeHint: hint,
        photos: photos.map((p) => ({ servedKey: p.served_key, byteSize: p.byte_size })),
      }
    },

    getFilingSettings: () => filings.getSettings(),
    claimFiling: (filingId, attempt) => filings.claim(filingId, attempt),
    listRunningFilings: () => filings.listRunningFilings(),
  }
}
