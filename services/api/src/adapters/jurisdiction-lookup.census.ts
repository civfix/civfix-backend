import { fetchJsonWithTimeout } from "./http-fetch.js"

export interface JurisdictionLookupResult {
  geoid: string
  name: string
  layer: "place" | "county" | "state"
}

export class JurisdictionLookupUnavailableError extends Error {
  constructor(reason: string) {
    super(`jurisdiction lookup unavailable: ${reason}`)
    this.name = "JurisdictionLookupUnavailableError"
  }
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

export const CENSUS_DEFAULT_TIMEOUT_MS = 2500

const CENSUS_QUERY_PARAMS = {
  benchmark: "Public_AR_Current",
  vintage: "Current_Current",
  format: "json",
} as const

export class CensusJurisdictionLookup implements JurisdictionLookup {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch | undefined

  constructor(options: CensusJurisdictionLookupOptions) {
    this.baseUrl = options.baseUrl
    this.timeoutMs = options.timeoutMs ?? CENSUS_DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl
  }

  async lookup(lat: number, lng: number): Promise<JurisdictionLookupResult | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    const params = new URLSearchParams({
      x: String(lng),
      y: String(lat),
      ...CENSUS_QUERY_PARAMS,
    })
    const result = await fetchJsonWithTimeout<unknown>(`${this.baseUrl}?${params.toString()}`, {
      timeoutMs: this.timeoutMs,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    })
    if (!result.ok) {
      throw new JurisdictionLookupUnavailableError(result.kind)
    }
    return parseCensusGeographies(result.json)
  }
}

export const JURISDICTION_LOOKUP_CACHE_TTL_MS = 5 * 60_000
const JURISDICTION_LOOKUP_CACHE_MAX_ENTRIES = 512
const JURISDICTION_LOOKUP_CACHE_DECIMALS = 4

export interface CachedJurisdictionLookupOptions {
  ttlMs?: number
  maxEntries?: number
  coordDecimals?: number
  now?: () => number
}

export class CachedJurisdictionLookup implements JurisdictionLookup {
  private readonly inner: JurisdictionLookup
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly coordDecimals: number
  private readonly now: () => number
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
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return this.inner.lookup(lat, lng)

    const key = `${lat.toFixed(this.coordDecimals)},${lng.toFixed(this.coordDecimals)}`
    const at = this.now()
    const hit = this.entries.get(key)
    if (hit !== undefined) {
      if (hit.expiresAt > at) return hit.result
      this.entries.delete(key)
    }

    const result = this.inner.lookup(lat, lng).catch((err: unknown) => {
      this.entries.delete(key)
      throw err
    })
    this.entries.set(key, { expiresAt: at + this.ttlMs, result })
    this.evict(at)
    return result
  }

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
