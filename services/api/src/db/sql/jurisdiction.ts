/**
 * Single source of truth for the jurisdiction-resolution spatial query.
 *
 * Given a longitude/latitude, find the most-specific jurisdiction whose boundary CONTAINS the point.
 * "Most specific" = place before county before state, so an address inside an incorporated city
 * resolves to the city; a point in unincorporated county land (inside the county polygon but outside
 * every place polygon) resolves to the county; a point outside all boundaries resolves to null.
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
 * The canonical SQL text, exported for assertions/inspection. Uses positional params $1 (lng) and
 * $2 (lat). NOTE the coordinate order: ST_MakePoint takes (x=lng, y=lat).
 */
export const JURISDICTION_RESOLVE_SQL = `SELECT geoid, name, layer
FROM jurisdictions
WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
ORDER BY CASE layer WHEN 'place' THEN 0 WHEN 'county' THEN 1 ELSE 2 END
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
