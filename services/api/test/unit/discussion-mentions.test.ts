/**
 * Pure unit tests (no DB, no network) for the discussion @city-mention parser + the jurisdiction-handle
 * slug derivation (src/services/discussion-mentions.ts).
 *
 * These two helpers are the DB-free core of the discussion city-forward path: parseCityMention decides
 * whether a message references its report's OWN jurisdiction handle (word-boundary, case-insensitive), and
 * jurisdictionHandle derives the stable slug used by the backfill CLI + the on-the-fly read derivation. Both
 * are exercised here in isolation so the matching rules (boundaries, casing, partial-token rejection) and
 * the slug rules (prefix/suffix stripping, punctuation collapse) are locked.
 */

import { describe, expect, it } from "vitest"
import { jurisdictionHandle, parseCityMention } from "../../src/services/discussion-mentions.js"

describe("jurisdictionHandle", () => {
  it("lowercases + collapses punctuation to single underscores", () => {
    expect(jurisdictionHandle("San Francisco")).toBe("san_francisco")
    expect(jurisdictionHandle("St. Paul")).toBe("st_paul")
    expect(jurisdictionHandle("Washington, D.C.")).toBe("washington_d_c")
  })

  it("drops a leading '<kind> of ' administrative prefix", () => {
    expect(jurisdictionHandle("City of San Francisco")).toBe("san_francisco")
    expect(jurisdictionHandle("Town of Cary")).toBe("cary")
    expect(jurisdictionHandle("County of Los Angeles")).toBe("los_angeles")
  })

  it("strips a trailing administrative descriptor word", () => {
    expect(jurisdictionHandle("Los Angeles County")).toBe("los_angeles")
    expect(jurisdictionHandle("Jersey City")).toBe("jersey")
  })

  it("trims leading/trailing underscores", () => {
    expect(jurisdictionHandle("  -Oakland-  ")).toBe("oakland")
  })

  it("returns null for null/empty/all-punctuation names", () => {
    expect(jurisdictionHandle(null)).toBeNull()
    expect(jurisdictionHandle(undefined)).toBeNull()
    expect(jurisdictionHandle("   ")).toBeNull()
    expect(jurisdictionHandle("---")).toBeNull()
  })

  it("is deterministic", () => {
    expect(jurisdictionHandle("San Francisco")).toBe(jurisdictionHandle("San Francisco"))
  })
})

describe("parseCityMention", () => {
  it("matches an @handle anywhere in the body, case-insensitively", () => {
    expect(parseCityMention("hey @sf please fix this", "sf")).toBe("sf")
    expect(parseCityMention("HEY @SF PLEASE", "sf")).toBe("SF")
    expect(parseCityMention("@sf", "SF")).toBe("sf")
  })

  it("returns the matched handle as it appeared in the body (casing preserved)", () => {
    expect(parseCityMention("ping @SanFrancisco now", "sanfrancisco")).toBe("SanFrancisco")
  })

  it("respects a leading boundary: an @ preceded by a word char is NOT a mention", () => {
    expect(parseCityMention("email me at user@sf.gov", "sf")).toBeNull()
  })

  it("respects a trailing boundary: @sf must not match @sfo", () => {
    expect(parseCityMention("contact @sfo airport", "sf")).toBeNull()
  })

  it("matches when wrapped in punctuation", () => {
    expect(parseCityMention("(@sf) and others", "sf")).toBe("sf")
    expect(parseCityMention("cc: @sf, @oakland", "sf")).toBe("sf")
  })

  it("does not match a different handle", () => {
    expect(parseCityMention("hey @oakland", "sf")).toBeNull()
  })

  it("never matches a null/empty/whitespace handle", () => {
    expect(parseCityMention("@sf", null)).toBeNull()
    expect(parseCityMention("@sf", "")).toBeNull()
    expect(parseCityMention("@sf", "   ")).toBeNull()
  })

  it("handles an underscore handle as a single token", () => {
    expect(parseCityMention("tagging @san_francisco here", "san_francisco")).toBe("san_francisco")
    // A trailing word char after the underscore handle breaks the boundary.
    expect(parseCityMention("@san_franciscox", "san_francisco")).toBeNull()
  })
})
