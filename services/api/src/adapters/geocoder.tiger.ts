/**
 * REAL Geocoder adapter backed by the local US Census TIGER boundaries already loaded into the
 * `jurisdictions` PostGIS table. Reverse-geocodes a lng/lat to a human "City, ST" label without any
 * external HTTP call: everything is derived from polygons civfix already owns.
 *
 * How the label is built:
 *   1. The most-specific containing jurisdiction (place -> county -> state) supplies the locality
 *      NAME. For an address inside an incorporated city that is the city; for unincorporated land it
 *      is the county; with only a state polygon it is the state itself.
 *   2. The 2-letter STATE abbreviation is derived from the GEOID of the containing STATE-layer row.
 *      Census GEOIDs are hierarchical and begin with the 2-digit state FIPS code: a state geoid IS
 *      that 2-digit code ("06" = California), a county geoid is state+county ("06037"), and a place
 *      geoid is state+place ("0644000"). So the leading two characters of ANY resolved geoid are the
 *      state FIPS, which STATE_FIPS_TO_USPS maps to the USPS abbreviation ("06" -> "CA"). We derive the
 *      abbreviation from the FIPS prefix of the already-resolved locality geoid directly (no extra
 *      query) ONLY for the FIPS-hierarchical layers (place/county/state). federal/tribal jurisdictions are
 *      not Census FIPS geoids — dev data uses alpha prefixes (NPS-, USFS-, BIA-) but production ingest can
 *      carry numeric ids whose first two digits would be a valid-but-WRONG state FIPS — so for those layers
 *      we skip the prefix and run the authoritative containing-state query, as we also do when the prefix
 *      lookup yields nothing. Either way a label is still produced.
 *
 * Result shape: "Los Angeles, CA". When no jurisdiction contains the point at all, returns null (the
 * caller decides how to present "outside coverage"). When the state cannot be determined we return
 * the bare locality name rather than appending a wrong/blank state.
 *
 * Seam rule: this adapter may touch the DB, but it is the ONLY geocoding implementation that does;
 * the rest of the app depends on the vendor-neutral Geocoder interface. DB access is lazy (a `getSql`
 * thunk) so constructing the adapter in the DI container does not force a connection.
 */

import { AppError } from "@civfix/shared"
import type { Geocoder } from "@civfix/shared/interfaces"
import type { Sql } from "../db/client.js"
import { resolveJurisdiction } from "../db/sql/jurisdiction.js"

/**
 * US state / territory FIPS (2-digit, zero-padded) -> USPS 2-letter abbreviation. This is a fixed,
 * public Census code list (it does not change), so it lives in-process rather than in a lookup table.
 */
const STATE_FIPS_TO_USPS: Readonly<Record<string, string>> = {
  "01": "AL",
  "02": "AK",
  "04": "AZ",
  "05": "AR",
  "06": "CA",
  "08": "CO",
  "09": "CT",
  "10": "DE",
  "11": "DC",
  "12": "FL",
  "13": "GA",
  "15": "HI",
  "16": "ID",
  "17": "IL",
  "18": "IN",
  "19": "IA",
  "20": "KS",
  "21": "KY",
  "22": "LA",
  "23": "ME",
  "24": "MD",
  "25": "MA",
  "26": "MI",
  "27": "MN",
  "28": "MS",
  "29": "MO",
  "30": "MT",
  "31": "NE",
  "32": "NV",
  "33": "NH",
  "34": "NJ",
  "35": "NM",
  "36": "NY",
  "37": "NC",
  "38": "ND",
  "39": "OH",
  "40": "OK",
  "41": "OR",
  "42": "PA",
  "44": "RI",
  "45": "SC",
  "46": "SD",
  "47": "TN",
  "48": "TX",
  "49": "UT",
  "50": "VT",
  "51": "VA",
  "53": "WA",
  "54": "WV",
  "55": "WI",
  "56": "WY",
  "60": "AS",
  "66": "GU",
  "69": "MP",
  "72": "PR",
  "78": "VI",
}

/**
 * Map a Census geoid to its USPS state abbreviation via the leading 2-digit FIPS prefix. Returns null
 * for a geoid whose prefix is not a known state/territory code.
 */
export function uspsFromGeoid(geoid: string): string | null {
  const fips = geoid.slice(0, 2)
  return STATE_FIPS_TO_USPS[fips] ?? null
}

/**
 * Format a "City, ST" label from a locality name and an optional state abbreviation. When the state
 * is unknown, returns the bare name (never "City, " with a dangling comma).
 */
export function formatCityStateLabel(name: string, usps: string | null): string {
  return usps ? `${name}, ${usps}` : name
}

export interface TigerGeocoderOptions {
  /** Lazy accessor for the raw postgres-js tag. Called per request; lets DI avoid early connections. */
  getSql: () => Sql
}

const NO_SQL = "adapter misconfigured: geocoder.tiger has no SQL accessor"

export class TigerGeocoder implements Geocoder {
  private readonly getSql: () => Sql

  constructor(options: TigerGeocoderOptions) {
    if (typeof options?.getSql !== "function") {
      // Constructed without a DB accessor: fail loud rather than silently returning null labels.
      throw AppError.internal(NO_SQL)
    }
    this.getSql = options.getSql
  }

  /**
   * Reverse-geocode (lat, lng) to "City, ST". Returns null when the point is outside every known
   * boundary. NOTE the coordinate order handed to the spatial query: resolveJurisdiction(sql, lng, lat).
   */
  async cityStateLabel(lat: number, lng: number): Promise<string | null> {
    const sql = this.getSql()

    const resolved = await resolveJurisdiction(sql, lng, lat)
    if (!resolved) return null

    // Census geoids are hierarchical, so the leading 2 chars of a place/county/state geoid ARE the
    // state FIPS (see file header) — derive the USPS from the already-resolved geoid first and avoid a
    // second spatial round-trip. This shortcut is ONLY valid for the FIPS-hierarchical layers
    // (place/county/state). federal/tribal jurisdictions are NOT Census FIPS geoids: dev data uses alpha
    // prefixes (NPS-*, USFS-*, BIA-*) for which uspsFromGeoid returns null, but the production ingest CLI
    // can carry NUMERIC ids (e.g. a BIA/ArcGIS GEOID/OBJECTID) whose first two digits are a valid-but-WRONG
    // state FIPS — so for those layers we must NOT trust the prefix and instead run the authoritative
    // containing-state query (the original behavior). When the prefix is unavailable/untrusted, fall back.
    const fipsLayer =
      resolved.layer === "place" || resolved.layer === "county" || resolved.layer === "state"
    const usps =
      (fipsLayer ? uspsFromGeoid(resolved.geoid) : null) ?? (await this.stateAbbrFor(sql, lng, lat))
    return formatCityStateLabel(resolved.name, usps)
  }

  /**
   * Determine the USPS state abbreviation for the point from the STATE-layer jurisdiction that
   * actually contains it (authoritative even across odd geoid schemes). This is only used as a
   * fallback for points whose resolved locality geoid has a non-FIPS prefix (federal/tribal land);
   * for ordinary place/county/state geoids the caller derives the USPS from the geoid prefix directly
   * and never reaches this query. Returns null when no state polygon covers the point.
   */
  private async stateAbbrFor(sql: Sql, lng: number, lat: number): Promise<string | null> {
    const rows = await sql<{ geoid: string }[]>`
      SELECT geoid
      FROM jurisdictions
      WHERE layer = 'state'
        AND ST_Contains(geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
      LIMIT 1
    `
    return uspsFromGeoid(rows[0]?.geoid ?? "") ?? null
  }
}
