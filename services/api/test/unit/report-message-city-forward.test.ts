/**
 * cityForwardFields is the PURE, DB-free helper the report message mapper (chat-repository.drizzle.ts
 * toMessageDTO) uses to derive the "@city" surfacing on a REPORT chat message DTO from (a) the per-row
 * forwarded_to_city EXISTS column and (b) the report's resolved jurisdiction. The SQL join (report_message_forwards -> forwarded_to_city) + the jurisdiction lookup are
 * exercised by the Docker-gated pg suite.
 *
 *   - forwardedToCity mirrors the forwarded_to_city column (the "Forwarded to city" pill);
 *   - cityMention is present ONLY when the report has a jurisdiction whose (effective) handle the body
 *     actually @mentions, and its `forwarded` flag mirrors forwardedToCity (the tint degrades to plain text
 *     when there's no mention or no jurisdiction).
 */

import { describe, expect, it } from "vitest"
import {
  cityForwardFields,
  type ReportCityContext,
} from "../../src/services/chat-repository.drizzle.js"

const SF: ReportCityContext = { geoid: "0600001", name: "City of San Francisco", handle: "sf" }
// No stored handle: the effective handle derives from the name ("City of San Francisco" -> "san_francisco").
const SF_DERIVED: ReportCityContext = {
  geoid: "0600001",
  name: "City of San Francisco",
  handle: null,
}
// Neither a stored nor a derivable handle (all-punctuation name): there is nothing to @mention, so the tint
// degrades to plain text (cityMention null).
const NO_HANDLE: ReportCityContext = { geoid: "0600001", name: "!!!", handle: null }

describe("cityForwardFields (report @city surfacing)", () => {
  it("sets forwardedToCity:true and a forwarded cityMention when the audit says forwarded + body @mentions @city", () => {
    const out = cityForwardFields({ body: "pls fix @sf", forwarded_to_city: true }, SF)
    expect(out.forwardedToCity).toBe(true)
    expect(out.cityMention).toEqual({
      handle: "sf",
      geoid: "0600001",
      name: "City of San Francisco",
      forwarded: true,
    })
  })

  it("sets forwardedToCity:false and cityMention.forwarded:false when @mentioned but not yet forwarded", () => {
    const out = cityForwardFields({ body: "@sf please", forwarded_to_city: false }, SF)
    expect(out.forwardedToCity).toBe(false)
    expect(out.cityMention?.forwarded).toBe(false)
    expect(out.cityMention?.geoid).toBe("0600001")
  })

  it("treats an absent forwarded_to_city column as not forwarded", () => {
    const out = cityForwardFields({ body: "@sf hi", forwarded_to_city: undefined }, SF)
    expect(out.forwardedToCity).toBe(false)
    expect(out.cityMention?.forwarded).toBe(false)
  })

  it("omits cityMention (null) when the body does NOT @mention the city, but still reports forwardedToCity", () => {
    const out = cityForwardFields({ body: "just chatting", forwarded_to_city: true }, SF)
    expect(out.forwardedToCity).toBe(true)
    expect(out.cityMention).toBeNull()
  })

  it("omits cityMention when the report has no jurisdiction (degrades to plain text)", () => {
    const out = cityForwardFields({ body: "@sf help", forwarded_to_city: false }, null)
    expect(out.forwardedToCity).toBe(false)
    expect(out.cityMention).toBeNull()
  })

  it("matches the DERIVED handle when the jurisdiction has no stored handle", () => {
    // "City of San Francisco" -> effective handle "san_francisco"; the body must @mention that.
    const out = cityForwardFields(
      { body: "hey @san_francisco fix this", forwarded_to_city: false },
      SF_DERIVED,
    )
    expect(out.cityMention).not.toBeNull()
    expect(out.cityMention?.handle).toBe("san_francisco")
    // "@sf" would NOT match the derived handle.
    expect(
      cityForwardFields({ body: "@sf", forwarded_to_city: false }, SF_DERIVED).cityMention,
    ).toBeNull()
  })

  it("omits cityMention when no handle is stored or derivable (nothing to @mention)", () => {
    // With no usable handle, there is nothing for the body to @mention, so cityMention is null.
    expect(
      cityForwardFields({ body: "@0600001", forwarded_to_city: false }, NO_HANDLE).cityMention,
    ).toBeNull()
  })

  it("does not @city-tint a system/empty body (null body coalesces to empty, no mention)", () => {
    const out = cityForwardFields({ body: null, forwarded_to_city: false }, SF)
    expect(out.forwardedToCity).toBe(false)
    expect(out.cityMention).toBeNull()
  })
})
