/**
 * Reverse-geocodes against the TIGER boundaries already in the `jurisdictions` table, so no external HTTP
 * call is made. The most-specific containing jurisdiction (place -> county -> state) names the locality.
 *
 * Census GEOIDs are hierarchical and begin with the 2-digit state FIPS ("06", "06037", "0644000"), so the
 * state abbreviation comes from the resolved geoid's prefix with no extra query. That shortcut holds only
 * for the place/county/state layers: federal/tribal ids are not FIPS geoids, and production ingest can
 * carry numeric ids whose first two digits are a valid-but-WRONG state FIPS, so those layers run the
 * containing-state query instead.
 *
 * DB access is a lazy `getSql` thunk so constructing the adapter in the DI container opens no connection.
 */

import { AppError } from "@civfix/shared"
import type { Geocoder } from "@civfix/shared/interfaces"
import type { Sql } from "../db/client.js"
import { resolveJurisdiction } from "../db/sql/jurisdiction.js"

/** A fixed public Census code list, so it lives in-process rather than in a lookup table. */
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

export function uspsFromGeoid(geoid: string): string | null {
  const fips = geoid.slice(0, 2)
  return STATE_FIPS_TO_USPS[fips] ?? null
}

export function formatCityStateLabel(name: string, usps: string | null): string {
  return usps ? `${name}, ${usps}` : name
}

export interface TigerGeocoderOptions {
  getSql: () => Sql
}

const NO_SQL = "adapter misconfigured: geocoder.tiger has no SQL accessor"

export class TigerGeocoder implements Geocoder {
  private readonly getSql: () => Sql

  constructor(options: TigerGeocoderOptions) {
    if (typeof options?.getSql !== "function") {
      throw AppError.internal(NO_SQL)
    }
    this.getSql = options.getSql
  }

  /** Note the argument order flip: this takes (lat, lng) but resolveJurisdiction takes (lng, lat). */
  async cityStateLabel(lat: number, lng: number): Promise<string | null> {
    const sql = this.getSql()

    const resolved = await resolveJurisdiction(sql, lng, lat)
    if (!resolved) return null

    // The geoid prefix is trusted only on FIPS-hierarchical layers; a federal/tribal numeric id (e.g. a
    // BIA/ArcGIS OBJECTID) would yield a valid-but-WRONG state (see file header).
    const fipsLayer =
      resolved.layer === "place" || resolved.layer === "county" || resolved.layer === "state"
    const usps =
      (fipsLayer ? uspsFromGeoid(resolved.geoid) : null) ?? (await this.stateAbbrFor(sql, lng, lat))
    return formatCityStateLabel(resolved.name, usps)
  }

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
