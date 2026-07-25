/**
 * Single source of truth for the jurisdiction-resolution spatial query.
 *
 * Given a longitude/latitude, find the most-specific jurisdiction whose boundary CONTAINS the point.
 * "Most specific" = federal land, then tribal land (both land-OWNERSHIP overrides), then place, then
 * county, then state. A point inside a national park / forest / military base resolves to the federal
 * owner even when it also falls within a city/county polygon (ownership supersedes local incorporation);
 * an address inside an incorporated city resolves to the city; a point in unincorporated county land
 * (inside the county polygon but outside every place polygon) resolves to the county; outside all -> null.
 *
 * The ordering is `layer rank, priority, geoid` (JURISDICTION_RESOLVE_ORDER_BY below): the rank decides
 * BETWEEN layers, so the specificity above holds whatever `priority` contains, and `priority` then
 * `geoid` only break ties WITHIN one layer (same-layer overlaps are common — overlapping PAD-US federal
 * parcels, a dev fixture polygon over the real boundary — and without a total order Postgres could hand
 * the write-time resolver and the backfill different rows for the same point). `priority` is therefore a
 * live sort key at every resolution site: it cannot change which layer wins, but curating it DOES change
 * which of two same-layer polygons a point routes to. The GiST index on jurisdictions.geom (0001_core.sql)
 * makes the ST_Contains scan an index lookup.
 *
 * This is THE query the jurisdiction-service will use; importing it here keeps a single definition so
 * the spatial integration test and the service can never drift. It is written against the raw
 * postgres-js tag (`Sql`) because it relies on PostGIS functions (ST_Contains / ST_MakePoint /
 * ST_SetSRID) that Drizzle's query builder does not model.
 */

import type { Sql } from "../client.js"
import type { JURISDICTION_LAYER_VALUES } from "../schema/types.js"

/** A resolved jurisdiction: just the routing-relevant columns. */
export interface ResolvedJurisdiction {
  geoid: string
  name: string
  layer: (typeof JURISDICTION_LAYER_VALUES)[number]
}

/**
 * THE single source of truth for the jurisdiction layer ranking — a bare SQL `CASE` expression that
 * maps a row's `layer` to an ascending rank (lower rank = more specific authority, wins under
 * `ORDER BY ... LIMIT 1`). The ordering is federal(0) -> tribal(1) -> place(2) -> county(3) ->
 * state/ELSE(4): the two land-OWNERSHIP overrides (federal, then tribal) supersede local incorporation,
 * then the most-specific civil boundary (place, then county, then state) wins.
 *
 * It reaches every resolution site through JURISDICTION_RESOLVE_ORDER_BY (below), which appends the
 * tie-breaks, so they can NEVER drift:
 *   1. JURISDICTION_RESOLVE_SQL below — the write-time resolver run on every report/anon insert.
 *   2. The backfill loops (src/db/backfill-keyset.ts, driven by backfill-jurisdictions.ts and the
 *      reference-code backfill), which re-resolve NULL jurisdiction_geoid rows via the same correlated
 *      `ORDER BY` (embedded with `sql.unsafe`, since this is a trusted, code-defined string — never user
 *      input).
 *
 * The byte-for-byte tie between this constant and JURISDICTION_RESOLVE_SQL is asserted by
 * jurisdiction-sql.test.ts; the literal value is pinned by jurisdiction-backfill.test.ts. Keep it free
 * of leading/trailing whitespace so it can be dropped straight into an `ORDER BY` clause.
 */
export const JURISDICTION_LAYER_RANK_CASE =
  "CASE layer WHEN 'federal' THEN 0 WHEN 'tribal' THEN 1 WHEN 'place' THEN 2 WHEN 'county' THEN 3 ELSE 4 END" as const

/**
 * THE `ORDER BY` list every resolution site uses: the layer rank FIRST, then two total-order tie-breaks.
 *
 * The rank alone leaves SAME-LAYER overlaps undecided, and those are common: PAD-US emits overlapping
 * federal Fee parcels, and a dev-seeded fixture polygon can overlap the real boundary it duplicates.
 * Without a stable secondary key Postgres is free to return either row, so the write-time resolver and the
 * backfill could stamp DIFFERENT jurisdictions (hence different routing) for the same point.
 *
 * `priority` comes second so curated per-row ordering is honoured within a layer (it is uniform per layer
 * today: federal -2, tribal -1, place 0, county 1, state 2 — see ingest LAYER_RANK / LAYER_PRIORITY), and
 * `geoid` (the PK, a total order) breaks the remaining ties so the choice is deterministic forever.
 */
export const JURISDICTION_RESOLVE_ORDER_BY = `${JURISDICTION_LAYER_RANK_CASE}, priority, geoid` as const

/**
 * The canonical SQL text, exported for assertions/inspection. Uses positional params $1 (lng) and
 * $2 (lat). NOTE the coordinate order: ST_MakePoint takes (x=lng, y=lat).
 *
 * The `ORDER BY` interpolates JURISDICTION_RESOLVE_ORDER_BY (which embeds JURISDICTION_LAYER_RANK_CASE)
 * so the resolver and the backfill CLI share one ordering definition.
 */
export const JURISDICTION_RESOLVE_SQL = `SELECT geoid, name, layer
FROM jurisdictions
WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
ORDER BY ${JURISDICTION_RESOLVE_ORDER_BY}
LIMIT 1` as const

/**
 * Resolve the jurisdiction containing (lng, lat). Returns the most-specific match, or null if the
 * point is outside every known boundary. NOTE the coordinate order: (lng = x, lat = y).
 */
export async function resolveJurisdiction(
  sql: Sql,
  lng: number,
  lat: number,
): Promise<ResolvedJurisdiction | null> {
  const rows = await sql.unsafe<ResolvedJurisdiction[]>(JURISDICTION_RESOLVE_SQL, [lng, lat])
  return rows[0] ?? null
}
