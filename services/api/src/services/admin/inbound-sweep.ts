
import type { Container } from "../../di.js"
import {
  processInboundObject,
  INBOUND_PENDING_PREFIX,
  type InboundProcessorDeps,
} from "./inbound-processor.js"
import { makeDrizzleMailRepository } from "./mail-repository.drizzle.js"
import { applyInboundEffects } from "./inbound-thread-correlation.js"

export const INBOUND_SWEEP_BATCH = 200
const LIST_PAGE = 100

/**
 * How many stored inbound messages whose side effects never applied are re-driven per run, and how long
 * a message is left alone first. The delay only avoids pointless contention with the webhook that is
 * probably still applying them; correctness comes from the `effects_applied_at` claim, not the delay.
 */
export const INBOUND_EFFECTS_REDRIVE_BATCH = 100
export const INBOUND_EFFECTS_REDRIVE_MIN_AGE_MS = 60_000

export interface InboundSweepResult {
  scanned: number
  processed: number
  errors: number
  parked: number
  effectsRedriven: number
  effectsErrors: number
  effectsError?: string
  listError?: string
}

export async function runInboundSweep(
  container: Container,
  opts: {
    batch?: number
    deps?: InboundProcessorDeps
    now?: () => Date
    effectsBatch?: number
    effectsMinAgeMs?: number
  } = {},
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
      return {
        scanned,
        processed,
        errors: errors + 1,
        parked,
        listError: errorMessage(err),
        ...(await redriveEffects(container, opts)),
      }
    }
    for (const key of keys) {
      if (scanned >= cap) {
        return { scanned, processed, errors, parked, ...(await redriveEffects(container, opts)) }
      }
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

  return { scanned, processed, errors, parked, ...(await redriveEffects(container, opts)) }
}

/**
 * The durable backstop for inbound SIDE EFFECTS (report status transition, reporter notification, event
 * timeline). The message insert is deduped on message_id, so a transient failure right after the insert
 * used to lose the transition forever: re-delivering the .eml only ever produced a "replay". Effects are
 * therefore re-driven from the STORED row, claimed via `effects_applied_at` so exactly one runner applies
 * them, and released again on failure so the next run retries.
 */
async function redriveEffects(
  container: Container,
  opts: {
    deps?: InboundProcessorDeps
    now?: () => Date
    effectsBatch?: number
    effectsMinAgeMs?: number
  },
): Promise<{ effectsRedriven: number; effectsErrors: number; effectsError?: string }> {
  const now = (opts.now ?? (() => new Date()))()
  const minAge = opts.effectsMinAgeMs ?? INBOUND_EFFECTS_REDRIVE_MIN_AGE_MS
  const limit = opts.effectsBatch ?? INBOUND_EFFECTS_REDRIVE_BATCH
  let mailRepo
  try {
    mailRepo = opts.deps?.mailRepo ?? makeDrizzleMailRepository(container.getDb().sql)
  } catch (err) {
    return { effectsRedriven: 0, effectsErrors: 1, effectsError: errorMessage(err) }
  }

  let pending
  try {
    pending = await mailRepo.findMessagesPendingEffects({
      before: new Date(now.getTime() - minAge),
      limit,
    })
  } catch (err) {
    return { effectsRedriven: 0, effectsErrors: 1, effectsError: errorMessage(err) }
  }

  let effectsRedriven = 0
  let effectsErrors = 0
  let effectsError: string | undefined
  for (const { message, thread } of pending) {
    try {
      await applyInboundEffects(
        container,
        opts.deps?.adminReportRepo,
        opts.deps?.cleanupRepo,
        mailRepo,
        thread,
        message,
      )
      effectsRedriven += 1
    } catch (err) {
      effectsErrors += 1
      effectsError = errorMessage(err)
    }
  }
  return {
    effectsRedriven,
    effectsErrors,
    ...(effectsError !== undefined ? { effectsError } : {}),
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
