import type { AddressPrecision } from "@civfix/shared"
import type { GeocodeCacheEntry } from "./geocode-cache.js"

export interface GeocodeCacheRowSelect {
  address: string | null
  address_precision: AddressPrecision | null
  city_state_label: string | null
  provider: string | null
  resolved_at: Date
}

export interface GeocodeCacheRepository {
  findByPointKey(pointKey: string): Promise<GeocodeCacheRowSelect | undefined>
  upsert(pointKey: string, entry: GeocodeCacheEntry, now: () => Date): Promise<void>
}
