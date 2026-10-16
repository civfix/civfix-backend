/**
 * Reverse geocoding to a human "City, ST" label behind a vendor-neutral interface.
 */

export interface Geocoder {
  cityStateLabel(lat: number, lng: number): Promise<string | null>
}
