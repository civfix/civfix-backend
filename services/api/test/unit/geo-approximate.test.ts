import { describe, it, expect } from "vitest"
import {
  approximateLocationFor,
  CF_IP_CITY_RADIUS_KM,
  CF_IP_RADIUS_KM,
  type HomeRegion,
} from "../../src/services/geo-approximate.js"

const HOME: HomeRegion = { lat: 34.0522, lng: -118.2437, radiusKm: 40 }

describe("approximateLocationFor", () => {
  it("uses the Cloudflare IP fix when the headers arrived through the trusted edge", () => {
    expect(
      approximateLocationFor(
        {
          headers: { "cf-iplatitude": "40.7128", "cf-iplongitude": "-74.006" },
          trusted: true,
        },
        HOME,
      ),
    ).toEqual({ lat: 40.7128, lng: -74.006, radiusKm: CF_IP_RADIUS_KM, source: "ip" })
  })

  it("tightens the radius when Cloudflare also resolved a city", () => {
    const result = approximateLocationFor(
      {
        headers: {
          "cf-iplatitude": "40.7128",
          "cf-iplongitude": "-74.006",
          "cf-ipcity": "New York",
        },
        trusted: true,
      },
      HOME,
    )
    expect(result.source).toBe("ip")
    expect(result.radiusKm).toBe(CF_IP_CITY_RADIUS_KM)
  })

  it("keeps the wider radius when the city header is present but empty", () => {
    const result = approximateLocationFor(
      {
        headers: { "cf-iplatitude": "40.7128", "cf-iplongitude": "-74.006", "cf-ipcity": "  " },
        trusted: true,
      },
      HOME,
    )
    expect(result.radiusKm).toBe(CF_IP_RADIUS_KM)
  })

  it("falls back to the home region when the headers did NOT come from the trusted edge", () => {
    expect(
      approximateLocationFor(
        {
          headers: { "cf-iplatitude": "40.7128", "cf-iplongitude": "-74.006" },
          trusted: false,
        },
        HOME,
      ),
    ).toEqual({ lat: 34.0522, lng: -118.2437, radiusKm: 40, source: "region" })
  })

  it("falls back to the home region when there are no CF geo headers at all", () => {
    expect(approximateLocationFor({ headers: {}, trusted: true }, HOME)).toEqual({
      lat: 34.0522,
      lng: -118.2437,
      radiusKm: 40,
      source: "region",
    })
  })

  it("falls back to the home region on malformed or out-of-range header numbers", () => {
    for (const headers of [
      { "cf-iplatitude": "abc", "cf-iplongitude": "-74.006" },
      { "cf-iplatitude": "999", "cf-iplongitude": "-74.006" },
      { "cf-iplatitude": "40.7128" },
    ]) {
      expect(approximateLocationFor({ headers, trusted: true }, HOME).source).toBe("region")
    }
  })

  it("answers with the configured home region, not a hardcoded one", () => {
    expect(
      approximateLocationFor(
        { headers: {}, trusted: false },
        { lat: 41.8781, lng: -87.6298, radiusKm: 25 },
      ),
    ).toEqual({ lat: 41.8781, lng: -87.6298, radiusKm: 25, source: "region" })
  })
})
