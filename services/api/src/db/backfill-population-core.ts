import type { Sql } from "./client.js"

export const ACS_POP_VAR = "B01003_001E"

export const DEFAULT_ACS_YEAR = 2023

export type CensusJsonFetch = (url: string) => Promise<unknown[][]>

const CENSUS_FETCH_TIMEOUT_MS = 20_000

const defaultFetchJson: CensusJsonFetch = async (url) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CENSUS_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    const contentType = res.headers.get("content-type") ?? ""
    if (res.url.includes("missing_key") || (!contentType.includes("json") && res.redirected)) {
      throw new Error(
        "Census API requires an API key: set CENSUS_API_KEY (free, instant: https://api.census.gov/data/key_signup.html)",
      )
    }
    if (!res.ok) throw new Error(`Census API ${res.status} ${res.statusText}`)
    if (!contentType.includes("json")) {
      throw new Error(
        `Census API returned a non-JSON response (${res.status}); check the query/year`,
      )
    }
    return (await res.json()) as unknown[][]
  } finally {
    clearTimeout(timer)
  }
}

function acsUrl(
  year: number,
  forClause: string,
  inClause: string | null,
  key: string | null,
): string {
  const params = new URLSearchParams()
  params.set("get", ACS_POP_VAR)
  params.set("for", forClause)
  if (inClause) params.set("in", inClause)
  if (key) params.set("key", key)
  return `https://api.census.gov/data/${year}/acs/acs5?${params.toString()}`
}

/**
 * The order these columns concatenate into a GEOID (state "06" + county "037" = "06037"). They are always
 * read in this order, never header order, so an extra column (a `NAME` variable, a Census reshuffle) can
 * never end up inside a geoid. An unlisted level is ignored, so callers must fetch only these levels.
 */
const ACS_GEO_COLUMNS = ["state", "county", "place"] as const

export function parseAcs(rows: unknown[][]): { geoid: string; population: number }[] {
  if (!Array.isArray(rows) || rows.length < 2) return []
  const header = (rows[0] ?? []).map(String)
  const varIdx = header.indexOf(ACS_POP_VAR)
  if (varIdx < 0) return []
  const geoCols = ACS_GEO_COLUMNS.map((c) => header.indexOf(c)).filter(
    (i) => i >= 0 && i !== varIdx,
  )
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
      "fetched 0 ACS rows: every Census call failed. The Census API requires CENSUS_API_KEY " +
        "(free, instant: https://api.census.gov/data/key_signup.html); set it and re-run.",
    )
    return { fetched: 0, updated: 0, states: states.length }
  }
  log(`fetched ${fetched} ACS population rows (ACS5 ${year}); applying...`)
  const updated = await applyPopulations(sql, collected)
  return { fetched, updated, states: states.length }
}
