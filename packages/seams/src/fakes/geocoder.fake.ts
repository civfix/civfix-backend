import type { Geocoder } from "../interfaces/geocoder.js"

/**
 * In-memory Geocoder. Returns "Los Angeles, CA" by default, or a registered override for a
 * rounded lat/lng key so tests can pin a deterministic label.
 */
export class FakeGeocoder implements Geocoder {
  defaultLabel = "Los Angeles, CA"
  private readonly overrides = new Map<string, string>()

  private static key(lat: number, lng: number): string {
    return `${lat.toFixed(3)},${lng.toFixed(3)}`
  }

  /** Test helper: pin a label for a coordinate (matched to 3 decimal places). */
  setLabel(lat: number, lng: number, label: string): void {
    this.overrides.set(FakeGeocoder.key(lat, lng), label)
  }

  cityStateLabel(lat: number, lng: number): Promise<string | null> {
    const override = this.overrides.get(FakeGeocoder.key(lat, lng))
    return Promise.resolve(override ?? this.defaultLabel)
  }
}
