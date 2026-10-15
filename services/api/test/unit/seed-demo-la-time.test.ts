import { describe, expect, it } from "vitest"
import { laLocalToUtc } from "../../src/db/seed-demo-la.js"

describe("seed-demo-la local time", () => {
  it("places 9:00 local at 17:00 UTC in winter (PST)", () => {
    expect(laLocalToUtc(Date.UTC(2026, 0, 17), 9, 0, 0).toISOString()).toBe(
      "2026-01-17T17:00:00.000Z",
    )
  })

  it("places 9:00 local at 16:00 UTC in summer (PDT)", () => {
    expect(laLocalToUtc(Date.UTC(2026, 6, 18), 9, 30, 0).toISOString()).toBe(
      "2026-07-18T16:30:00.000Z",
    )
  })

  it("keeps an evening local time on its own local calendar day", () => {
    expect(laLocalToUtc(Date.UTC(2026, 10, 7), 21, 15, 5).toISOString()).toBe(
      "2026-11-08T05:15:05.000Z",
    )
  })
})
