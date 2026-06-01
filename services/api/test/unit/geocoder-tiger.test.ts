import { describe, it, expect } from "vitest"
import { AppError } from "@civfix/shared"
import {
  uspsFromGeoid,
  formatCityStateLabel,
  TigerGeocoder,
} from "../../src/adapters/geocoder.tiger.js"

/**
 * Unit tests for the TIGER geocoder's pure, DB-free helpers: the Census-GEOID -> USPS state mapping
 * (which underpins the whole "City, ST" derivation) and the label formatter. The DB-backed
 * cityStateLabel path is exercised by the Docker-gated integration test.
 */

describe("uspsFromGeoid", () => {
  it("maps a 2-digit state geoid to its USPS abbreviation", () => {
    expect(uspsFromGeoid("06")).toBe("CA")
    expect(uspsFromGeoid("36")).toBe("NY")
  })

  it("uses the leading 2-digit FIPS prefix for county and place geoids", () => {
    // County 06037 (LA County) and place 0644000 (LA city) both start with 06 -> CA.
    expect(uspsFromGeoid("06037")).toBe("CA")
    expect(uspsFromGeoid("0644000")).toBe("CA")
    // Texas place.
    expect(uspsFromGeoid("4805000")).toBe("TX")
  })

  it("returns null for an unknown FIPS prefix", () => {
    expect(uspsFromGeoid("99")).toBeNull()
    expect(uspsFromGeoid("")).toBeNull()
  })
})

describe("formatCityStateLabel", () => {
  it("joins name and state when the abbreviation is known", () => {
    expect(formatCityStateLabel("Los Angeles", "CA")).toBe("Los Angeles, CA")
  })

  it("returns the bare name (no dangling comma) when the state is unknown", () => {
    expect(formatCityStateLabel("Los Angeles", null)).toBe("Los Angeles")
  })
})

describe("TigerGeocoder construction", () => {
  it("throws when constructed without a SQL accessor", () => {
    // @ts-expect-error intentionally missing required getSql to assert the loud failure.
    expect(() => new TigerGeocoder({})).toThrow(AppError)
  })
})
