import {
  FILING_RESULT_JOB,
  FilingResultPayloadSchema,
  type FilingResultPayload,
} from "@civfix/api/filings-worker"
import type { Jobs } from "@civfix/seams"

/** Every outcome goes back to the API on filing.result; the filer never writes a filing itself (D7). */
export async function sendFilingResult(
  jobs: Pick<Jobs, "enqueue">,
  payload: FilingResultPayload,
): Promise<void> {
  const parsed = FilingResultPayloadSchema.parse(payload)
  await jobs.enqueue(FILING_RESULT_JOB, parsed, {
    singletonKey: `${parsed.filingId}:${parsed.runId}`,
  })
}
