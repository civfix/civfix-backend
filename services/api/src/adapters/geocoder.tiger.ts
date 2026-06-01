/**
 * REAL Geocoder adapter backed by US Census TIGER data (reverse geocode to "City, ST").
 *
 * SCAFFOLD: body throws until a later step wires the TIGER lookup (local PostGIS table or HTTP).
 *
 * Seam rule: any geocoding vendor SDK/HTTP client may ONLY be imported in this file.
 */

import { AppError } from "@civfix/shared"
import type { Geocoder } from "@civfix/shared/interfaces"

export interface TigerGeocoderConfig {
  /** Optional override base URL for a hosted TIGER/geocoder endpoint. */
  baseUrl?: string
}

const NOT_IMPL = "adapter not implemented: geocoder.tiger"

export class TigerGeocoder implements Geocoder {
  private readonly config: TigerGeocoderConfig

  constructor(config: TigerGeocoderConfig = {}) {
    this.config = config
  }

  cityStateLabel(_lat: number, _lng: number): Promise<string | null> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }
}
