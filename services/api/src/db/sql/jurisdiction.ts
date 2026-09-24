/**
 * The one definition of jurisdiction resolution, so the service, the backfills and the spatial test can
 * never drift. The most specific containing boundary wins: federal land, then tribal land (land ownership
 * supersedes local incorporation, so a point in a national park resolves to the federal owner even inside
 * a city polygon), then place, county, state.
 *
 * `priority` cannot change which layer wins, but it does decide between two same-layer polygons, so
 * curating it changes routing.
 */

import type { Sql } from "../client.js"
import type { JURISDICTION_LAYER_VALUES } from "../schema/types.js"

export interface ResolvedJurisdiction {
  geoid: string
  name: string
  layer: (typeof JURISDICTION_LAYER_VALUES)[number]
}

/**
 * Reaches the write-time resolver and the backfill loops only through JURISDICTION_RESOLVE_ORDER_BY, so
 * the ranking can never drift between them. The backfills embed it with `sql.unsafe`, which is safe only
 * because it is a code-defined constant. Keep it free of surrounding whitespace so it drops straight into
 * an ORDER BY.
 */
export const JURISDICTION_LAYER_RANK_CASE =
  "CASE layer WHEN 'federal' THEN 0 WHEN 'tribal' THEN 1 WHEN 'place' THEN 2 WHEN 'county' THEN 3 ELSE 4 END" as const

/**
 * The rank alone leaves same-layer overlaps undecided, and those are common (overlapping PAD-US federal
 * parcels, a dev fixture over the real boundary). Without a total order Postgres may return either row,
 * so the resolver and the backfill could route the same point differently; `geoid` makes it deterministic.
 */
export const JURISDICTION_RESOLVE_ORDER_BY =
  `${JURISDICTION_LAYER_RANK_CASE}, priority, geoid` as const

/** ST_MakePoint takes (x = lng, y = lat), hence $1 = lng. */
export const JURISDICTION_RESOLVE_SQL = `SELECT geoid, name, layer
FROM jurisdictions
WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
ORDER BY ${JURISDICTION_RESOLVE_ORDER_BY}
LIMIT 1` as const

export async function resolveJurisdiction(
  sql: Sql,
  lng: number,
  lat: number,
): Promise<ResolvedJurisdiction | null> {
  const rows = await sql.unsafe<ResolvedJurisdiction[]>(JURISDICTION_RESOLVE_SQL, [lng, lat])
  return rows[0] ?? null
}
