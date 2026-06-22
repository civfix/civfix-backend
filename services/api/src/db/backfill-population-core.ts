/**
 * Population backfill CORE: fill jurisdictions.population from the US Census ACS 5-year API.
 *
 * TIGER boundary shapefiles carry NO population, so a fresh boundary ingest leaves population NULL (the
 * admin then shows "0" everywhere). The Census ACS detailed table B01003_001E (TOTAL POPULATION) is keyed
 * by the same FIPS GEOIDs our jurisdictions use, so we can join it back by geoid:
 *   - states   -> GEOID = state FIPS (2 digits)
 *   - counties -> GEOID = state + county (5 digits)
 *   - places   -> GEOID = state + place  (7 digits)
 * Federal (PAD-US) + tribal (AIANNH) rows have non-FIPS geoids (PADUS-/AIANNH-) and no ACS population, so
 * they are left as-is (0/NULL) by design.
 *
 * This module is guard-FREE (no main(), no CLI side effects) so it can be imported by both the CLI
 * (backfill-population.ts) and the local refresh tool (scripts/refresh-boundaries.ts) without the tsup
 * bundling trap. It uses the global `fetch` (Node 22) for the Census API; pass a `fetchJson` to test it
 * offline.
 */

import type { Sql } from "./client.js"

/** ACS5 detailed-table variable for total population. */
export const ACS_POP_VAR = "B01003_001E"

/**
 * Default ACS 5-year vintage. 2023 is the latest release guaranteed published well before this code runs
 * (Dec 2024); override per call/CLI to a newer vintage once it ships.
 */
export const DEFAULT_ACS_YEAR = 2023

/** Fetch a Census API URL and return its array-of-arrays body. Injectable so the core is unit-testable. */
export type CensusJsonFetch = (url: string) => Promise<unknown[][]>

const defaultFetchJson: CensusJsonFetch = async (url) => {
  const res = await fetch(url)
  // The Census API now REQUIRES an API key: an unkeyed request 302-redirects to /data/missing_key.html
  // (an HTML page), so a "successful" fetch can still be HTML. Detect that and fail with a clear, actionable
  // message instead of a cryptic "Unexpected token '<'" JSON parse error.
  const contentType = res.headers.get("content-type") ?? ""
  if (res.url.includes("missing_key") || (!contentType.includes("json") && res.redirected)) {
    throw new Error(
      "Census API requires an API key — set CENSUS_API_KEY (free, instant: https://api.census.gov/data/key_signup.html)",
    )
  }
  if (!res.ok) throw new Error(`Census API ${res.status} ${res.statusText}`)
  if (!contentType.includes("json")) {
    throw new Error(`Census API returned a non-JSON response (${res.status}); check the query/year`)
  }
  return (await res.json()) as unknown[][]
}

/** Build an ACS5 query URL for a geography selector (`for`, optional `in`), with an optional API key. */
function acsUrl(year: number, forClause: string, inClause: string | null, key: string | null): string {
  const params = new URLSearchParams()
  params.set("get", ACS_POP_VAR)
  params.set("for", forClause)
  if (inClause) params.set("in", inClause)
  if (key) params.set("key", key)
  return `https://api.census.gov/data/${year}/acs/acs5?${params.toString()}`
}

/**
 * Parse an ACS array-of-arrays body into {geoid, population}. Row 0 is the header
 * (e.g. ["B01003_001E","state","place"]); the GEOID is the concatenation of the geography component
 * columns (everything but the variable) in header order, which is exactly the FIPS hierarchy
 * (state[+county|+place]). Negative jumbo values are Census "not available" annotations -> dropped.
 */
export function parseAcs(rows: unknown[][]): { geoid: string; population: number }[] {
  if (!Array.isArray(rows) || rows.length < 2) return []
  const header = (rows[0] ?? []).map(String)
  const varIdx = header.indexOf(ACS_POP_VAR)
  if (varIdx < 0) return []
  const geoCols = header.map((_h, i) => i).filter((i) => i !== varIdx)
  const out: { geoid: string; population: number }[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!Array.isArray(row)) continue
    const pop = Number(row[varIdx])
    if (!Number.isFinite(pop) || pop < 0) continue
    const geoid = geoCols.map((i) => String(row[i] ?? "")).join("")
    if (geoid) out.push({ geoid, population: Math.round(pop) })
  }
  return out
}

/** Batch-apply {geoid, population} to existing jurisdictions (UNNEST join; rows with no match are no-ops). */
async function applyPopulations(
  sql: Sql,
  rows: { geoid: string; population: number }[],
): Promise<number> {
  let updated = 0
  const CHUNK = 1000
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const geoids = chunk.map((c) => c.geoid)
    const pops = chunk.map((c) => c.population)
    const res = await sql`
      UPDATE jurisdictions j
      SET population = data.population
      FROM unnest(${geoids}::text[], ${pops}::int[]) AS data(geoid, population)
      WHERE j.geoid = data.geoid
    `
    updated += res.count ?? 0
  }
  return updated
}

/**
 * Backfill jurisdictions.population from ACS for every FIPS layer present in the table: states (one call),
 * counties (one wildcard call), and places (one call per state FIPS that has places). Each call is
 * best-effort — a failing state/territory (Island Areas are NOT in ACS5) is logged and skipped, never
 * aborting the rest. Only existing jurisdictions are updated; ACS rows with no matching geoid are ignored.
 */
export async function backfillPopulation(
  sql: Sql,
  opts: {
    year?: number
    apiKey?: string | null
    fetchJson?: CensusJsonFetch
    log?: (m: string) => void
  } = {},
): Promise<{ fetched: number; updated: number; states: number }> {
  const year = opts.year ?? DEFAULT_ACS_YEAR
  const key = opts.apiKey ?? process.env.CENSUS_API_KEY ?? null
  const fetchJson = opts.fetchJson ?? defaultFetchJson
  const log = opts.log ?? (() => {})

  // State FIPS to loop for places: the 2-digit prefixes of the place rows actually in the table.
  const stateRows = await sql<{ ss: string }[]>`
    SELECT DISTINCT substring(geoid from 1 for 2) AS ss
    FROM jurisdictions
    WHERE layer = 'place' AND geoid ~ '^[0-9]{2}'
    ORDER BY ss
  `
  const states = stateRows.map((r) => r.ss)

  const collected: { geoid: string; population: number }[] = []
  const tryFetch = async (label: string, url: string): Promise<void> => {
    try {
      collected.push(...parseAcs(await fetchJson(url)))
    } catch (err) {
      log(`${label} ACS fetch failed (skipped): ${(err as Error).message}`)
    }
  }

  await tryFetch("states", acsUrl(year, "state:*", null, key))
  await tryFetch("counties", acsUrl(year, "county:*", "state:*", key))
  for (const ss of states) {
    await tryFetch(`places[${ss}]`, acsUrl(year, "place:*", `state:${ss}`, key))
  }

  const fetched = collected.length
  if (fetched === 0) {
    log(
      "fetched 0 ACS rows — every Census call failed. The Census API requires CENSUS_API_KEY " +
        "(free, instant: https://api.census.gov/data/key_signup.html); set it and re-run.",
    )
    return { fetched: 0, updated: 0, states: states.length }
  }
  log(`fetched ${fetched} ACS population rows (ACS5 ${year}); applying...`)
  const updated = await applyPopulations(sql, collected)
  return { fetched, updated, states: states.length }
}
