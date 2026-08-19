
import type { Container } from "../../di.js"
import {
  processInboundObject,
  INBOUND_PENDING_PREFIX,
  type InboundProcessorDeps,
} from "./inbound-processor.js"

export const INBOUND_SWEEP_BATCH = 200
const LIST_PAGE = 100

export interface InboundSweepResult {
  scanned: number
  processed: number
  errors: number
  parked: number
  listError?: string
}

export async function runInboundSweep(
  container: Container,
  opts: { batch?: number; deps?: InboundProcessorDeps } = {},
): Promise<InboundSweepResult> {
  const storage = opts.deps?.storage ?? container.inboundStorage
  const cap = opts.batch ?? INBOUND_SWEEP_BATCH
  let cursor: string | undefined
  let scanned = 0
  let processed = 0
  let errors = 0
  let parked = 0

  do {
    const listOpts = cursor !== undefined ? { cursor, limit: LIST_PAGE } : { limit: LIST_PAGE }
    let keys: string[]
    let next: string | undefined
    try {
      const page = await storage.list(INBOUND_PENDING_PREFIX, listOpts)
      keys = page.keys
      next = page.cursor
    } catch (err) {
      return { scanned, processed, errors: errors + 1, parked, listError: errorMessage(err) }
    }
    for (const key of keys) {
      if (scanned >= cap) return { scanned, processed, errors, parked }
      scanned += 1
      try {
        const result = await processInboundObject(container, key, opts.deps ?? {})
        if (result.outcome !== "skipped") processed += 1
        if (result.outcome === "failed") parked += 1
      } catch {
        errors += 1
      }
    }
    cursor = next
  } while (cursor !== undefined && scanned < cap)

  return { scanned, processed, errors, parked }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
