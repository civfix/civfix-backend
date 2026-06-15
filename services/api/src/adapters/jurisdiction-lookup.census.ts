/**
 * Backend-local seam: the WRITE-TIME jurisdiction FALLBACK backed by the US Census Geocoder
 * (Geographies/coordinates) API.
 *
 * Why this exists
 * ---------------
 * Jurisdiction resolution runs ONCE, at report/anon write time: the local PostGIS resolver
 * (db/sql/jurisdiction.ts -> ST_Contains over the `jurisdictions` table) maps a point to the most-
 * specific government that owns it. When the table has NO polygon covering the point that resolver
 * returns null, the report stores jurisdiction_geoid = NULL, and the admin buckets it as "Unmapped".
 * Loading the full TIGER/PAD-US/AIANNH boundary set fixes that for good (doc 20, Path A), but that is an
 * ops-heavy bulk ingest. This seam is the zero-ops bridge: on a LOCAL MISS we ask the Census Geocoder
 * "what place/county/state contains this point?", lazily upsert that jurisdiction row (geoid+name, NO
 * polygon), and return its geoid so the report self-maps. The Census Geocoder is itself hosting TIGER, so
 * it returns exactly the FIPS-hierarchical place/county/state geoids our resolver already understands.
 *
 * Best-effort contract (CRITICAL)
 * -------------------------------
 *   - This call is INLINE on the report-creation hot path, so it is strictly best-effort: a slow or down
 *     Census API must NEVER block or fail a report. `lookup()` is wrapped so that a non-200 response, an
 *     AbortController timeout, a network error, a non-JSON / malformed body, or a parser miss ALL resolve
 *     to `null` (today's local-only "Unmapped" behavior) — it NEVER throws to the caller.
 *   - A short AbortController timeout (default ~2500ms) bounds the blast radius of a slow API.
 *
 * Scope / limit
 * -------------
 * The Census Geographies API returns CIVIL boundaries only: Incorporated Places, Counties, States. It does
 * NOT expose land-OWNERSHIP layers (USGS PAD-US federal land, Census AIANNH tribal land). So this fallback
 * returns layer 'place' | 'county' | 'state' ONLY; federal/tribal ownership-override mapping still requires
 * the self-hosted PAD-US/AIANNH polygons (doc 20 §3). That is by design: the common municipal case self-
 * maps with zero ops, while ownership overrides stay on the authoritative self-hosted path.
 *
 * Seam rule + testability
 * -----------------------
 * The pure response parser (`parseCensusGeographies`) is factored out so the precedence + null handling are
 * unit-tested with NO network and NO DB. The HTTP impl takes an INJECTABLE base URL, timeout, and fetch so
 * tests fake the call entirely offline. The trivial `FakeJurisdictionLookup` returns null by default, which
 * reproduces today's local-only behavior in the all-fakes dev/test boot (no network, fully offline). Only
 * Node globals are used (global `fetch` + `AbortController`); this module pulls in NO npm dependency and
 * NOTHING from @civfix/shared (it is deliberately backend-local to avoid a contract release).
 */

/**
 * A successful jurisdiction lookup: the routing-relevant identity of the most-specific civil boundary the
 * Census Geocoder reports for a point. `layer` is intentionally narrowed to the three CIVIL layers the
 * API can return — federal/tribal ownership is never API-sourced (see the file header).
 */
export interface JurisdictionLookupResult {
  geoid: string
  name: string
  layer: "place" | "county" | "state"
}

/**
 * The write-time fallback seam. `lookup` returns the most-specific civil jurisdiction containing the
 * point, or null when the point is outside US civil coverage OR the call failed in any way (best-effort:
 * a null result is indistinguishable from "API unavailable", and the caller treats both as "no fallback").
 */
export interface JurisdictionLookup {
  lookup(lat: number, lng: number): Promise<JurisdictionLookupResult | null>
}

/**
 * The Census `result.geographies` collection keys, most-specific civil boundary first. The parser walks
 * these IN ORDER and takes the first non-empty collection's [0] feature, so an incorporated address maps to
 * its city, unincorporated county land to its county, and a bare-state hit to the state.
 *
 * Each tuple is [collection key in the API response, the civfix layer it maps to]. Pinned as a const tuple
 * so the precedence is a single source of truth shared by the parser and its tests.
 */
const CENSUS_LAYER_PRECEDENCE: ReadonlyArray<
  readonly [collectionKey: string, layer: JurisdictionLookupResult["layer"]]
> = [
  ["Incorporated Places", "place"],
  ["Counties", "county"],
  ["States", "state"],
] as const

/**
 * Read a non-empty trimmed string property off an unknown object, else null. Used to defensively pull
 * GEOID / NAME off a Census feature whose shape we do not statically trust.
 */
function readString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key]
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

/**
 * PURE, DB-free, network-free parser for a Census Geographies/coordinates response body.
 *
 * Navigates `json.result.geographies` (an object keyed by collection name, each an array of features) fully
 * defensively — every level is treated as `unknown` and narrowed, so a malformed/partial body can never
 * throw. Applies the CENSUS_LAYER_PRECEDENCE (Incorporated Places -> Counties -> States): for the FIRST
 * collection that is a non-empty array, it reads feature [0]'s GEOID + NAME; if BOTH are present it returns
 * `{ geoid, name, layer }`. A collection whose [0] feature is missing GEOID or NAME does NOT fall through to
 * a less-specific collection (the most-specific containing boundary is the answer even if its labels are
 * malformed) — it returns null, so the caller leaves the report unmapped rather than mis-routing it to a
 * county/state when a place clearly contained the point. Returns null when none of the three collections
 * exist or all are empty, or the body is not the expected shape.
 */
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
    // The most-specific collection wins. A present-but-unlabeled feature does not silently degrade to a
    // less-specific layer; we return null and leave the point unmapped rather than mis-route it.
    if (geoid === null || name === null) return null
    return { geoid, name, layer }
  }
  return null
}

/**
 * Construction options for the real Census lookup. The base URL, timeout, and fetch impl are all
 * INJECTABLE so tests fake the HTTP call with no network and no real timers.
 */
export interface CensusJurisdictionLookupOptions {
  /** Base URL of the Census Geographies/coordinates endpoint (no query string). */
  baseUrl: string
  /** AbortController timeout in ms. Defaults to DEFAULT_TIMEOUT_MS (~2500). */
  timeoutMs?: number
  /** Injectable fetch (defaults to the Node 22 global). Tests pass a fake to avoid the network. */
  fetchImpl?: typeof fetch
}

/** Default AbortController timeout: short, so a slow/down API never blocks report creation. */
const DEFAULT_TIMEOUT_MS = 2500

/**
 * REAL write-time fallback: query the US Census Geographies/coordinates API for the civil jurisdiction
 * containing a point.
 *
 * The request URL is `${baseUrl}?x={lng}&y={lat}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`
 * — NOTE the coordinate order (x = longitude, y = latitude). The benchmark/vintage are pinned to the
 * "Current" public release to reduce drift across Census vintages.
 *
 * Best-effort: the ENTIRE body is wrapped so a timeout/abort, a network error, a non-200 status, a non-JSON
 * body, or a parser miss all return null. It NEVER throws to the caller (see the file header).
 */
export class CensusJurisdictionLookup implements JurisdictionLookup {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: CensusJurisdictionLookupOptions) {
    this.baseUrl = options.baseUrl
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // Bind to globalThis so a destructured global fetch keeps its receiver (undici asserts on a detached
    // `this`). Tests inject their own fetchImpl and never hit this branch.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  async lookup(lat: number, lng: number): Promise<JurisdictionLookupResult | null> {
    // One try/catch around the whole call so EVERY failure mode (timeout/abort, network, non-200, bad
    // JSON, parser miss) collapses to a null return — this is the best-effort contract.
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
      const res = await this.fetchImpl(url, { signal: controller.signal })
      if (!res.ok) return null

      // Parse the body in its own guard: a 200 with a truncated/HTML body must degrade to null, not throw.
      let body: unknown
      try {
        body = await res.json()
      } catch {
        return null
      }
      return parseCensusGeographies(body)
    } catch {
      // Timeout/abort, DNS/network error, or any other surprise — best-effort fall-through to null.
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Trivial FAKE used outside production (dev/test). Returns null by default so the all-fakes boot reproduces
 * today's local-only behavior with ZERO network — the server boots fully offline and a local miss simply
 * stays "Unmapped" exactly as before this fallback existed. Tests that want to force a hit pass a canned
 * result to the constructor.
 */
export class FakeJurisdictionLookup implements JurisdictionLookup {
  private readonly canned: JurisdictionLookupResult | null

  constructor(canned: JurisdictionLookupResult | null = null) {
    this.canned = canned
  }

  lookup(_lat: number, _lng: number): Promise<JurisdictionLookupResult | null> {
    return Promise.resolve(this.canned)
  }
}
