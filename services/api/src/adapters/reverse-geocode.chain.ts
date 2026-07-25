/** A street-level reverse geocoder: coords -> one-line address, or null. Photon + Mapbox conform. */
export type ReverseGeocode = (lat: number, lng: number) => Promise<string | null>

/**
 * Overall budget for the whole chain. Each provider promises "never delays a submit" with its own ~4s
 * timeout, but the chain awaits them SEQUENTIALLY, so a dual outage stacked those timeouts and stalled
 * report creation for ~8s. The chain therefore has its own deadline: past it we return null (no address)
 * and let the caller fall back, exactly as it would on a provider failure.
 */
const CHAIN_BUDGET_MS = 5000

/**
 * Compose reverse geocoders into one that tries each in order and returns the first non-null result.
 * null/undefined entries are skipped, so callers can pass `cond ? make() : null` inline.
 *
 * The chain is bounded by CHAIN_BUDGET_MS in total, and the budget is SHARED OUT rather than handed
 * whole to the first provider. That split is the point: with one 5s ceiling and two providers on their
 * own 4s timeouts (Mapbox then Photon — see di.ts), a hung first provider ate 4 of the 5 seconds and the
 * fallback got ~1s, so the fallback the chain exists to provide almost always came back empty. Each
 * provider now gets `remaining / providers-left`, so a hung Mapbox is abandoned at 2.5s and Photon still
 * has 2.5s — while a FAST first provider hands its unused share to the next one (a provider that answers
 * in 200ms leaves 4.8s for the fallback), which is the common case.
 *
 * The trade-off is deliberate: a slow-but-eventually-answering first provider is now cut off at its share
 * instead of being allowed to consume the whole budget. Losing one provider's late answer is cheaper than
 * never reaching the second provider at all, and the caller treats "no address" as normal either way.
 *
 * A provider abandoned at its share keeps running (its own timeout ends it); its late answer is discarded
 * and a late rejection is swallowed, so it can never surface as an unhandled rejection.
 */
export function chainReverse(...providers: Array<ReverseGeocode | null | undefined>): ReverseGeocode {
  const active = providers.filter((p): p is ReverseGeocode => typeof p === "function")
  return async (lat: number, lng: number): Promise<string | null> => {
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
 * Run one provider with a hard per-attempt deadline. A provider that throws is treated as "no answer"
 * (the seam's contract is to fail open) so one misbehaving provider cannot reject the whole chain, and
 * the catch is attached to the attempt itself so it also covers a rejection that lands AFTER the deadline
 * won the race.
 */
async function withDeadline(
  provider: ReverseGeocode,
  lat: number,
  lng: number,
  timeoutMs: number,
): Promise<string | null> {
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
