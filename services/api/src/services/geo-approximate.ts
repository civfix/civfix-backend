import type { GetApproximateLocationResponse } from "@civfix/shared"
import { CF_CITY_HEADER, headerValue, parseCfGeo, type HeaderBag } from "../abuse/gps-sanity.js"

export const CF_IP_RADIUS_KM = 25
export const CF_IP_CITY_RADIUS_KM = 10

export interface HomeRegion {
  lat: number
  lng: number
  radiusKm: number
}

export interface CfGeoHeaders {
  headers: HeaderBag
  trusted: boolean
}

export function approximateLocationFor(
  cfGeo: CfGeoHeaders,
  homeRegion: HomeRegion,
): GetApproximateLocationResponse {
  if (cfGeo.trusted) {
    const point = parseCfGeo(cfGeo.headers)
    if (point !== null) {
      return {
        lat: point.lat,
        lng: point.lng,
        radiusKm:
          headerValue(cfGeo.headers, CF_CITY_HEADER) !== null
            ? CF_IP_CITY_RADIUS_KM
            : CF_IP_RADIUS_KM,
        source: "ip",
      }
    }
  }
  return {
    lat: homeRegion.lat,
    lng: homeRegion.lng,
    radiusKm: homeRegion.radiusKm,
    source: "region",
  }
}
