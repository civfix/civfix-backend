
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
  private readonly fetchImpl: typeof fetch

  constructor(options: CensusJurisdictionLookupOptions) {
    this.baseUrl = options.baseUrl
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  async lookup(lat: number, lng: number): Promise<JurisdictionLookupResult | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const params = new URLSearchParams({
        x: String(lng),
        y: String(lat),
        benchmark: "Public_AR_Current",
        vintage: "Current_Current",
        format: "json",
      })
      const url = `${this.baseUrl}?${params.toString()}`
      const res = await this.fetchImpl(url, { signal: controller.signal, redirect: "error" })
      if (!res.ok) return null

      let body: unknown
      try {
        body = await res.json()
      } catch {
        return null
      }
      return parseCensusGeographies(body)
    } catch {
      return null
    } finally {
      clearTimeout(timer)
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
