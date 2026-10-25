import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { FILING_CASE_ID_PATTERN } from "@civfix/contract"
import { IMMEDIATE_NEEDS_HUMAN_REASONS } from "@civfix/api/filings-worker"
import { z } from "zod"
import type { FilerLog } from "./config.js"
import { readContainedFile } from "./safe-file.js"
import type { ScriptRunResult } from "./script.js"

const RESULT_MAX_BYTES = 64 * 1024
const REASON_DETAIL_MAX = 500
const EVIDENCE_NAME_MAX = 100
const EVIDENCE_LISTED_MAX = 200
const EVIDENCE_KEPT_MAX = 20
const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024

// A bad name drops that one entry, not the result: rejecting a submitted result over its evidence list
// would retry a filing the city may already have.
const EvidenceNameSchema = z
  .string()
  .min(1)
  .max(EVIDENCE_NAME_MAX)
  .refine((name) => !name.includes("/") && !name.includes(".."))

/** out/result.json as the kit's result() writes it (D7). */
const RunResultFileSchema = z.object({
  outcome: z.enum(["submitted", "linked_existing", "needs_human"]),
  caseId: z.string().optional(),
  caseUrl: z.string().optional(),
  reason: z.enum(IMMEDIATE_NEEDS_HUMAN_REASONS).optional(),
  reasonDetail: z.string().max(REASON_DETAIL_MAX).optional(),
  evidence: z.array(z.unknown()).max(EVIDENCE_LISTED_MAX).default([]),
})

export type RunEnding =
  | { outcome: "submitted"; caseId?: string; caseUrl?: string; evidenceNames: string[] }
  | { outcome: "linked_existing"; caseId: string; caseUrl?: string; evidenceNames: string[] }
  | {
      outcome: "needs_human"
      reason: (typeof IMMEDIATE_NEEDS_HUMAN_REASONS)[number]
      reasonDetail?: string
      evidenceNames: string[]
    }
  | { outcome: "failed"; reason: "portal_error" | "uncertain_submission"; evidenceNames: string[] }

export interface OutputInput {
  outDir: string
  host: string
  dryRun: boolean
  run: ScriptRunResult
  log: FilerLog
}

/** Kept only on the portal's own host over https: a shared suffix would admit any tenant (D7). */
function portalCaseUrl(caseUrl: string | undefined, host: string): { caseUrl?: string } {
  if (caseUrl === undefined || !URL.canParse(caseUrl)) return {}
  const url = new URL(caseUrl)
  return url.protocol === "https:" && url.hostname === host ? { caseUrl } : {}
}

/** What a finished script run ends as, from its exit, the marker and out/result.json (D6, D7). */
export async function runEnding(input: OutputInput): Promise<RunEnding> {
  // Past the marker the submit may have reached the city, so a failure there is never retried (D6).
  const failed: RunEnding = {
    outcome: "failed",
    reason: input.run.marker ? "uncertain_submission" : "portal_error",
    evidenceNames: [],
  }
  if (input.run.timedOut || input.run.exitCode !== 0) return failed
  const read = await readContainedFile(join(input.outDir, "result.json"), {
    maxBytes: RESULT_MAX_BYTES,
    parentDir: await realpath(input.outDir),
  })
  if (read.kind !== "ok") {
    input.log("filer: no usable result.json", {
      why: read.kind === "missing" ? "missing" : read.why,
    })
    return failed
  }
  let parsed
  try {
    parsed = RunResultFileSchema.safeParse(JSON.parse(read.bytes.toString("utf8")))
  } catch {
    parsed = null
  }
  if (parsed?.success !== true) {
    input.log("filer: result.json is not a valid result")
    return failed
  }
  const r = parsed.data
  const evidenceNames = r.evidence.filter((name): name is string => typeof name === "string")
  const caseIdOk = r.caseId !== undefined && FILING_CASE_ID_PATTERN.test(r.caseId)

  if (input.dryRun) {
    const detail =
      r.outcome === "linked_existing" && caseIdOk
        ? { reasonDetail: `Would link to ${r.caseId}` }
        : {}
    return { outcome: "needs_human", reason: "dry_run", ...detail, evidenceNames }
  }
  switch (r.outcome) {
    case "submitted":
      if (r.caseId !== undefined && !caseIdOk) {
        // The bad id came after the submit click, so the city may well have the request.
        return { outcome: "failed", reason: "uncertain_submission", evidenceNames }
      }
      return {
        outcome: "submitted",
        ...(r.caseId !== undefined ? { caseId: r.caseId } : {}),
        ...portalCaseUrl(r.caseUrl, input.host),
        evidenceNames,
      }
    case "linked_existing":
      if (r.caseId === undefined || !caseIdOk) {
        return { outcome: "failed", reason: "portal_error", evidenceNames }
      }
      return {
        outcome: "linked_existing",
        caseId: r.caseId,
        ...portalCaseUrl(r.caseUrl, input.host),
        evidenceNames,
      }
    case "needs_human":
      if (r.reason === undefined) {
        input.log("filer: a needs_human result.json names no reason")
        return failed
      }
      return {
        outcome: "needs_human",
        reason: r.reason,
        ...(r.reasonDetail !== undefined ? { reasonDetail: r.reasonDetail } : {}),
        evidenceNames,
      }
  }
}

export interface EvidenceFile {
  name: string
  bytes: Buffer
  ext: "png" | "jpg"
  contentType: string
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

function sniff(bytes: Buffer): Pick<EvidenceFile, "ext" | "contentType"> | null {
  if (bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC))
    return { ext: "png", contentType: "image/png" }
  if (bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC))
    return { ext: "jpg", contentType: "image/jpeg" }
  return null
}

/** The listed screenshots that are safe to upload: bare PNG or JPEG files directly in out/ (D7). */
export async function collectEvidence(
  outDir: string,
  names: readonly string[],
  log: FilerLog,
): Promise<EvidenceFile[]> {
  const parentDir = await realpath(outDir)
  const kept: EvidenceFile[] = []
  for (const name of new Set(names)) {
    if (!EvidenceNameSchema.safeParse(name).success) {
      log("filer: evidence entry dropped: not a bare file name")
      continue
    }
    const read = await readContainedFile(join(outDir, name), {
      maxBytes: EVIDENCE_MAX_BYTES,
      parentDir,
    })
    const type = read.kind === "ok" ? sniff(read.bytes) : null
    if (read.kind !== "ok" || type === null) {
      const why =
        read.kind === "rejected" ? read.why : read.kind === "ok" ? "not a PNG or JPEG" : "missing"
      log("filer: evidence entry dropped", { name, why })
      continue
    }
    if (kept.length === EVIDENCE_KEPT_MAX) {
      log("filer: evidence entry dropped: over the limit", { name, limit: EVIDENCE_KEPT_MAX })
      continue
    }
    kept.push({ name, bytes: read.bytes, ...type })
  }
  return kept
}
