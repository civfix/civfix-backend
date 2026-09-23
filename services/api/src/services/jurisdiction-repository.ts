import type { JurisdictionLookupResult } from "../adapters/jurisdiction-lookup.census.js"
import type { ResolvedJurisdiction } from "../db/sql/jurisdiction.js"
import type { JurisdictionHealthRow } from "./jurisdiction-service.js"

export interface JurisdictionRepository {
  /** Takes (lng, lat), the ST_MakePoint order, like every method here. */
  resolveContaining(lng: number, lat: number): Promise<ResolvedJurisdiction | null>
  containingStateGeoid(lng: number, lat: number): Promise<string | null>
  exists(geoid: string): Promise<boolean>
  handleExists(handle: string): Promise<boolean>
  insertApiSourcedIfAbsent(hit: JurisdictionLookupResult): Promise<void>
  loadHealth(geoid: string): Promise<JurisdictionHealthRow | null>
}
