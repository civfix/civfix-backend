import { MS_PER_MINUTE } from "@civfix/api/time"
import {
  FILING_CITY_UPDATE_JOB,
  FilingClassificationSchema,
  type FilingCityUpdateJobData,
  type FilingClassification,
} from "@civfix/api/filings-worker"
import type { JobHandler, Jobs } from "@civfix/seams"
import { z } from "zod"
import { classifyArgs, runClaude, type ClaudeGate } from "./claude.js"
import type { FilerConfig, FilerLog } from "./config.js"
import type { FilerRunner } from "./filer-process.js"

export interface ClassifyDeps {
  jobs: Pick<Jobs, "enqueue">
  config: Pick<FilerConfig, "classifyModel">
  runner: FilerRunner
  gate: ClaudeGate
  log: FilerLog
  /** Tests only: the image's directory does not exist outside it. */
  classifyDir?: string
}

/**
 * Classify's cwd, made empty by the Dockerfile, node:node 0755. Claude Code reads a CLAUDE.md from its cwd
 * and every directory above it, so neither may be writable by filer, whose filing runs could plant one
 * (as anywhere under /tmp, /home/filer or /workspace).
 */
export const CLASSIFY_DIR = "/app/classify"

const CLASSIFY_TIMEOUT_MS = 5 * MS_PER_MINUTE
const READINGS_PER_TRY = 2

const ClassifyJobSchema = z.object({
  filingMessageId: z.uuid(),
  subject: z.string(),
  text: z.string().max(20_000),
})

/** What the API gets when Claude gave no valid reading: below 0.7, so the message is flagged (D11). */
function unread(summary: string): FilingClassification {
  return { caseId: null, status: "other", summary, confidence: 0 }
}

function parseReading(result: string): FilingClassification | null {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(result.trim())
  try {
    const parsed = FilingClassificationSchema.safeParse(JSON.parse(fenced?.[1] ?? result))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * `filing.classify` (D11): Claude reads one trusted city message, with no tools, and the reading goes to the
 * API on `filing.city_update`, which validates it again. Claude being unavailable fails the job so pg-boss
 * retries it once; on the last try the message is handed back unread instead.
 */
export function makeClassifyHandler(deps: ClassifyDeps): JobHandler {
  const handBack = async (filingMessageId: string, classification: FilingClassification) => {
    const data: FilingCityUpdateJobData = { filingMessageId, classification }
    await deps.jobs.enqueue(FILING_CITY_UPDATE_JOB, data, { singletonKey: filingMessageId })
  }

  return async (job) => {
    const { filingMessageId, subject, text } = ClassifyJobSchema.parse(job.data)
    const lastTry =
      job.retryCount !== undefined &&
      job.retryLimit !== undefined &&
      job.retryCount >= job.retryLimit
    const cwd = deps.classifyDir ?? CLASSIFY_DIR
    for (let reading = 1; reading <= READINGS_PER_TRY; reading++) {
      const outcome = await runClaude(
        { runner: deps.runner, gate: deps.gate, log: deps.log },
        {
          args: classifyArgs(deps.config.classifyModel),
          stdin: `Subject: ${subject}\n\n${text}\n`,
          cwd,
          timeoutMs: CLASSIFY_TIMEOUT_MS,
        },
      )
      if (outcome.kind === "failed" && outcome.reason === "ai_unavailable") {
        deps.log("filer: claude unavailable for a city message", { filingMessageId, lastTry })
        if (!lastTry) throw new Error(`filing.classify: Claude is unavailable: ${outcome.why}`)
        await handBack(filingMessageId, unread("Not read: Claude was unavailable."))
        return
      }
      const classification = outcome.kind === "ok" ? parseReading(outcome.result) : null
      if (classification !== null) {
        await handBack(filingMessageId, classification)
        return
      }
      deps.log("filer: no valid reading of a city message", { filingMessageId, reading })
    }
    await handBack(filingMessageId, unread("Not read: Claude gave no valid reading."))
  }
}
