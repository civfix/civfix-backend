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
  /**
   * Set when the R2 LIST itself failed (the inbound bucket is unreachable, or — the most likely cause —
   * the R2 token is not scoped to R2_INBOUND_BUCKET, so every list/get returns 403). A LIST failure
   * means we could not even enumerate the backlog, so it is a misconfiguration the caller must log
   * loudly. The sweep never throws on it (see file header): it returns this so the job stays observable
   * and the next tick retries once the access is granted.
   */
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

  do {
    const listOpts = cursor !== undefined ? { cursor, limit: LIST_PAGE } : { limit: LIST_PAGE }
    let keys: string[]
    let next: string | undefined
    try {
      const page = await storage.list(INBOUND_PENDING_PREFIX, listOpts)
      keys = page.keys
      next = page.cursor
    } catch (err) {
      // A LIST failure (inbound bucket unreachable / R2 token lacks access to it) must NOT throw out of
      // the sweep: that would fail the pg-boss job silently. Surface it as listError so the job logs a
      // loud, actionable line and the next tick retries. See InboundSweepResult.listError.
      return { scanned, processed, errors: errors + 1, listError: errorMessage(err) }
    }
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

/** Best-effort one-line description of a thrown value for logging (Error.message, else String()). */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
