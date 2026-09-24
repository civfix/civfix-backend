/**
 * Wall-clock bounds for work that has no timeout of its own. Callers differ only in WHICH error a timeout
 * raises, whether a rejection of the work is coerced or passed through, whether the timer is unref'd and
 * whether an abort side effect fires, so those are hooks and every caller keeps its own choices.
 *
 * This module stays import-free: it is inlined into the sandboxed image-lane child bundle.
 *
 * Rejecting does NOT cancel the wrapped work. The caller must arrange cancellation itself (`onElapsed`
 * exists for exactly that, e.g. aborting an in-flight download).
 */

export interface SettleWithinHooks {
  timeoutError: () => Error
  normalizeError?: (err: unknown) => unknown
  /** Fires BEFORE the rejection. */
  onElapsed?: () => void
  /** Unref the timer so a pending budget cannot by itself keep the process alive. */
  unref?: boolean
}

const coerceError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

export const passThroughRejection = (err: unknown): unknown => err

export function settleWithin<T>(p: Promise<T>, ms: number, hooks: SettleWithinHooks): Promise<T> {
  const normalize = hooks.normalizeError ?? coerceError
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      hooks.onElapsed?.()
      reject(hooks.timeoutError())
    }, ms)
    if (hooks.unref === true && typeof timer.unref === "function") timer.unref()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(normalize(err))
      },
    )
  })
}

/**
 * Resolves with `onTimeout()` rather than rejecting when `ms` elapses first; a rejection passes
 * through.
 */
export async function raceTimeout<T, F>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => F,
): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms)
  })
  try {
    return await Promise.race([work, expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
