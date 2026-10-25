import type { JobHandler } from "@civfix/seams"
import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../../di.js"

/** The `filing.result` handler: checks a filer's outcome, then applies it (D7). */
export function makeFilingResultHandler(
  _applyFilingResult: (payload: unknown) => Promise<{ applied: boolean }>,
): JobHandler {
  throw new Error("not implemented")
}

export async function registerFilingResultJobs(
  _container: Container,
  _logger?: FastifyBaseLogger,
): Promise<void> {
  throw new Error("not implemented")
}
