
import { fetchJsonOrNull } from "./http-fetch.js"

export interface JurisdictionLookupResult {
  geoid: string
  name: string
  layer: "place" | "county" | "state"
}

export interface JurisdictionLookup {
  lookup(lat: number, lng: number): Promise<JurisdictionLookupResult | null>
}

const CENSUS_LAYER_PRECEDENCE: ReadonlyArray<
  readonly [collectionKey: string, layer: JurisdictionLookupResult["layer"]]
> = [
  ["Incorporated Places", "place"],
  ["Counties", "county"],
  ["States", "state"],
] as const

function readString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key]
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

export function parseCensusGeographies(json: unknown): JurisdictionLookupResult | null {
  if (typeof json !== "object" || json === null) return null
  const result = (json as Record<string, unknown>).result
  if (typeof result !== "object" || result === null) return null
  const geographies = (result as Record<string, unknown>).geographies
  if (typeof geographies !== "object" || geographies === null) return null

  const collections = geographies as Record<string, unknown>
  for (const [collectionKey, layer] of CENSUS_LAYER_PRECEDENCE) {
    const features = collections[collectionKey]
    if (!Array.isArray(features) || features.length === 0) continue
    const feature = features[0]
    if (typeof feature !== "object" || feature === null) return null
    const f = feature as Record<string, unknown>
    const geoid = readString(f, "GEOID")
    const name = readString(f, "NAME")
    if (geoid === null || name === null) return null
    return { geoid, name, layer }
  }
  return null
}

export interface CensusJurisdictionLookupOptions {
  baseUrl: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 2500

export class CensusJurisdictionLookup implements JurisdictionLookup {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  /** Undefined when not injected, so the shared helper resolves globalThis.fetch at CALL time. */
  private readonly fetchImpl: typeof fetch | undefined

  constructor(options: CensusJurisdictionLookupOptions) {
    this.baseUrl = options.baseUrl
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl
  }

  async lookup(lat: number, lng: number): Promise<JurisdictionLookupResult | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    const params = new URLSearchParams({
      x: String(lng),
      y: String(lat),
      benchmark: "Public_AR_Current",
      vintage: "Current_Current",
      format: "json",
    })
    // Best-effort enrichment: transport failure, non-2xx, an unparseable body and the deadline all
    // collapse to null (see fetchJsonOrNull) so a report never fails on the Census being unreachable.
    const body = await fetchJsonOrNull<unknown>(`${this.baseUrl}?${params.toString()}`, {
      timeoutMs: this.timeoutMs,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    })
    return body === null ? null : parseCensusGeographies(body)
  }
}

/** Default memo lifetime: place/county/state boundaries are effectively static, so minutes are safe. */
export const JURISDICTION_LOOKUP_CACHE_TTL_MS = 5 * 60_000
/** Hard ceiling on memo entries (bounded memory: an anon caller must not be able to grow it forever). */
export const JURISDICTION_LOOKUP_CACHE_MAX_ENTRIES = 512
/**
 * Coordinate decimals the memo key is rounded to. 4 decimals is ~11 m at the equator: enough to collapse
 * "the same point asked again" (the abuse/amplification case) without ever answering across a real
 * municipal boundary, which is what a coarser bucket would risk.
 */
export const JURISDICTION_LOOKUP_CACHE_DECIMALS = 4

export interface CachedJurisdictionLookupOptions {
  ttlMs?: number
  maxEntries?: number
  coordDecimals?: number
  /** Injectable clock (ms) so TTL expiry is deterministic in tests. */
  now?: () => number
}

/**
 * TTL + size-bounded memo in FRONT of another JurisdictionLookup.
 *
 * WHY (A15 follow-up): the write-time fallback's lazily-inserted row has a NULL geom, so it never satisfies
 * the local resolver's ST_Contains — every repeat resolve of the same point re-fires the whole fallback.
 * On the anon-ok POST /map/resolve-jurisdiction that meant one outbound Census request (plus one write) per
 * request, forever, for a caller repeating a single point. Memoizing the LOOKUP is the cheapest place to
 * stop it: the geoid answer for a coordinate does not change between requests, and skipping the lookup also
 * skips the (idempotent) insert behind it.
 *
 * Cached values include MISSES (null): "this point is not in any Census place/county/state" is exactly as
 * repeatable as a hit, and an uncached negative would leave the amplification wide open.
 *
 * Concurrent identical calls share ONE in-flight promise (single flight), so a burst on the same point
 * makes one outbound request rather than N. A rejected lookup is never retained.
 *
 * The memo key is the ROUNDED coordinate (JURISDICTION_LOOKUP_CACHE_DECIMALS); the FULL-precision
 * coordinate is what gets passed to the wrapped lookup, so the first caller in a bucket still gets an
 * exact answer. Process-local by design (no cross-process coherence needed: the row it guards is inserted
 * idempotently, so a cold process simply re-does the work once).
 */
export class CachedJurisdictionLookup implements JurisdictionLookup {
  private readonly inner: JurisdictionLookup
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly coordDecimals: number
  private readonly now: () => number
  /** Insertion-ordered (Map) so the oldest write is the first eviction candidate. */
  private readonly entries = new Map<
    string,
    { expiresAt: number; result: Promise<JurisdictionLookupResult | null> }
  >()

  constructor(inner: JurisdictionLookup, options: CachedJurisdictionLookupOptions = {}) {
    this.inner = inner
    this.ttlMs = options.ttlMs ?? JURISDICTION_LOOKUP_CACHE_TTL_MS
    this.maxEntries = options.maxEntries ?? JURISDICTION_LOOKUP_CACHE_MAX_ENTRIES
    this.coordDecimals = options.coordDecimals ?? JURISDICTION_LOOKUP_CACHE_DECIMALS
    this.now = options.now ?? (() => Date.now())
  }

  lookup(lat: number, lng: number): Promise<JurisdictionLookupResult | null> {
    // Non-finite input is the wrapped impl's own reject-early case; never keyed or cached.
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return this.inner.lookup(lat, lng)

    const key = `${lat.toFixed(this.coordDecimals)},${lng.toFixed(this.coordDecimals)}`
    const at = this.now()
    const hit = this.entries.get(key)
    if (hit !== undefined) {
      if (hit.expiresAt > at) return hit.result
      this.entries.delete(key)
    }

    const result = this.inner.lookup(lat, lng).catch((err: unknown) => {
      // Never retain a failure: the next caller should get a real attempt, not a cached rejection.
      this.entries.delete(key)
      throw err
    })
    this.entries.set(key, { expiresAt: at + this.ttlMs, result })
    this.evict(at)
    return result
  }

  /** Drop expired entries first, then the oldest writes, until the ceiling holds. */
  private evict(at: number): void {
    if (this.entries.size <= this.maxEntries) return
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= at) this.entries.delete(key)
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) return
      this.entries.delete(oldest.value)
    }
  }
}

export class FakeJurisdictionLookup implements JurisdictionLookup {
  private readonly canned: JurisdictionLookupResult | null

  constructor(canned: JurisdictionLookupResult | null = null) {
    this.canned = canned
  }

  lookup(_lat: number, _lng: number): Promise<JurisdictionLookupResult | null> {
    return Promise.resolve(this.canned)
  }
}
