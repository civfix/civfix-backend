/**
 * Inbound-mail sweep: the durable backstop for the catch-all pipeline. The Cloudflare Email Worker
 * writes every message to R2 (inbound/pending/<id>.eml) as the source of truth and best-effort nudges
 * the webhook; this sweep LISTs that prefix and processes anything the webhook missed (the API was
 * offline / the nudge failed). Run once at boot and on a cron (INBOUND_SWEEP_CRON).
 *
 * Modeled on the media-worker orphan sweep: a bounded batch per run (so a backlog drains over several
 * ticks instead of one giant pass), best-effort per key (one poison object never aborts the run), and
 * never throws. processInboundObject is idempotent (message_id dedup + idempotent R2 delete), so the
 * sweep racing the webhook on the same object is safe.
 */

import type { Container } from "../../di.js"
import {
  processInboundObject,
  INBOUND_PENDING_PREFIX,
  type InboundProcessorDeps,
} from "./inbound-processor.js"

/** Default max objects processed per sweep run (a backlog drains across multiple cron ticks). */
export const INBOUND_SWEEP_BATCH = 200
/** R2 LIST page size per round. */
const LIST_PAGE = 100

export interface InboundSweepResult {
  scanned: number
  processed: number
  errors: number
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

  do {
    const listOpts = cursor !== undefined ? { cursor, limit: LIST_PAGE } : { limit: LIST_PAGE }
    const { keys, cursor: next } = await storage.list(INBOUND_PENDING_PREFIX, listOpts)
    for (const key of keys) {
      if (scanned >= cap) return { scanned, processed, errors }
      scanned += 1
      try {
        const result = await processInboundObject(container, key, opts.deps ?? {})
        if (result.outcome !== "skipped") processed += 1
      } catch {
        // Best-effort: a single failing key does not abort the run; the next sweep retries it.
        errors += 1
      }
    }
    cursor = next
  } while (cursor !== undefined && scanned < cap)

  return { scanned, processed, errors }
}
