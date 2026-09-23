import type { AddressPrecision } from "@civfix/shared"

export type PointResolver<T> = (lat: number, lng: number) => Promise<T | null>

/**
 * `line` carries no localized decoration: the "Near " prefix on a landmark is added by the UI, the only
 * layer that knows the viewer's language. Never claim a rung the data does not support: a street with no
 * house number is `intersection`, not `street`.
 */
export interface ReverseResult {
  line: string
  precision: AddressPrecision
  /** Diagnostics and cache bookkeeping only; never served to a client. */
  provider: string
}

export type ReverseGeocode = PointResolver<ReverseResult>

/**
 * Providers each carry a ~4s timeout but are awaited SEQUENTIALLY, so a dual outage once stalled report
 * creation for ~8s. Past this deadline the chain returns null, as it would on a provider failure.
 */
const CHAIN_BUDGET_MS = 5000

/**
 * null/undefined entries are skipped, so callers can pass `cond ? make() : null` inline.
 *
 * The budget is SHARED OUT (`remaining / providers-left`) rather than handed whole to the first provider:
 * with one 5s ceiling and two providers on 4s timeouts, a hung first provider left the fallback ~1s, so the
 * fallback the chain exists for almost always came back empty. A fast first provider hands its unused
 * share on. Cutting off a slow-but-eventually-answering first provider is the deliberate trade-off.
 *
 * An abandoned provider keeps running until its own timeout; its late answer is discarded and a late
 * rejection is swallowed, so it can never surface as an unhandled rejection.
 */
export function chainReverse<T>(
  ...providers: Array<PointResolver<T> | null | undefined>
): PointResolver<T> {
  const active = providers.filter((p): p is PointResolver<T> => typeof p === "function")
  return async (lat: number, lng: number): Promise<T | null> => {
    if (active.length === 0) return null

    const deadline = Date.now() + CHAIN_BUDGET_MS
    for (const [index, provider] of active.entries()) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return null
      const share = Math.ceil(remaining / (active.length - index))
      const result = await withDeadline(provider, lat, lng, share)
      if (result) return result
    }
    return null
  }
}

/**
 * A throwing provider counts as "no answer" (the seam fails open). The catch sits on the attempt itself so
 * it also covers a rejection that lands AFTER the deadline won the race.
 */
async function withDeadline<T>(
  provider: PointResolver<T>,
  lat: number,
  lng: number,
  timeoutMs: number,
): Promise<T | null> {
  const attempt = (async () => provider(lat, lng))().catch(() => null)
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    return await Promise.race([attempt, budget])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
