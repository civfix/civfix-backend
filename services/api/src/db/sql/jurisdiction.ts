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
 * The ordering is done by the layer rank, NOT by the `priority` column, so this query is correct even
 * if priorities are not yet curated. The GiST index on jurisdictions.geom (0001_core.sql) makes the
 * ST_Contains scan an index lookup.
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
 * This constant is interpolated into TWO places so they can NEVER drift:
 *   1. JURISDICTION_RESOLVE_SQL below — the write-time resolver run on every report/anon insert.
 *   2. The Phase-5 backfill CLI (src/db/backfill-jurisdictions.ts), which re-resolves NULL
 *      reports.jurisdiction_geoid rows via the same LATERAL `ORDER BY` (embedded with `sql.unsafe`,
 *      since this is a trusted, code-defined string — never user input).
 *
 * The byte-for-byte tie between this constant and JURISDICTION_RESOLVE_SQL is asserted by
 * jurisdiction-sql.test.ts; the literal value is pinned by jurisdiction-backfill.test.ts. Keep it free
 * of leading/trailing whitespace so it can be dropped straight into an `ORDER BY` clause.
 */
export const JURISDICTION_LAYER_RANK_CASE =
  "CASE layer WHEN 'federal' THEN 0 WHEN 'tribal' THEN 1 WHEN 'place' THEN 2 WHEN 'county' THEN 3 ELSE 4 END" as const

/**
 * The canonical SQL text, exported for assertions/inspection. Uses positional params $1 (lng) and
 * $2 (lat). NOTE the coordinate order: ST_MakePoint takes (x=lng, y=lat).
 *
 * The `ORDER BY` interpolates JURISDICTION_LAYER_RANK_CASE so the resolver and the backfill CLI share
 * one ranking definition. The interpolation is value-preserving: the resulting string is byte-identical
 * to the previous hand-written literal (asserted in jurisdiction-sql.test.ts).
 */
export const JURISDICTION_RESOLVE_SQL = `SELECT geoid, name, layer
FROM jurisdictions
WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
ORDER BY ${JURISDICTION_LAYER_RANK_CASE}
LIMIT 1` as const

/**
 * Resolve the jurisdiction containing (lng, lat). Returns the most-specific match, or null if the
 * point is outside every known boundary.
 *
 * @param sql raw postgres-js tag (e.g. dbHandle.sql).
 * @param lng longitude / x, in [-180, 180], SRID 4326.
 * @param lat latitude  / y, in [-90, 90],  SRID 4326.
 */
export async function resolveJurisdiction(
  sql: Sql,
  lng: number,
  lat: number,
): Promise<ResolvedJurisdiction | null> {
  const rows = await sql.unsafe<ResolvedJurisdiction[]>(JURISDICTION_RESOLVE_SQL, [lng, lat])
  return rows[0] ?? null
}
