/**
 * One settle-or-reject-with-a-typed-error primitive.
 *
 * Two boundaries in the worker need a JS-side wall clock: the per-job budget (media.checks) and the sharp
 * pipeline (sandbox/image.ts, since libvips has no JS-observable timeout). Both had their own copy of the
 * same race-free shape; the differences that matter are only WHICH error type is thrown and whether an
 * abort side effect fires, so both are expressed as hooks here.
 *
 * NOTE: rejecting does NOT cancel the wrapped work. The caller must arrange cancellation itself
 * (`onElapsed` exists for exactly that - e.g. aborting an in-flight download).
 */

export interface SettleWithinHooks {
  /** Build the rejection used when the budget elapses. */
  timeoutError: () => Error
  /** Normalize a rejection from the wrapped promise (defaults to a passthrough Error coercion). */
  normalizeError?: (err: unknown) => Error
  /** Fired the moment the budget elapses, BEFORE the rejection (e.g. abort an in-flight request). */
  onElapsed?: () => void
  /** Unref the timer so a pending budget cannot by itself keep the process alive. */
  unref?: boolean
}

const coerceError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

/** Reject with `hooks.timeoutError()` if `p` has not settled within `ms`. */
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
