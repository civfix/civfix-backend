import type { JobHandlerArg } from "@civfix/shared/interfaces"

// The shared Jobs seam hands a handler only { id, data }. The pg-boss adapter adds the retry position so
// a handler can tell its last attempt apart; any other Jobs implementation leaves it out, which reads as
// "not the last attempt" and keeps the plain throw-to-retry behavior.
export interface JobAttempt {
  retryCount: number
  retryLimit: number
}

export type JobHandlerArgWithAttempt = JobHandlerArg & Partial<JobAttempt>

export function isFinalJobAttempt(job: JobHandlerArg): boolean {
  const { retryCount, retryLimit } = job as JobHandlerArgWithAttempt
  return (
    typeof retryCount === "number" && typeof retryLimit === "number" && retryCount >= retryLimit
  )
}
