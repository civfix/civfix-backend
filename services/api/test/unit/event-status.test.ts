import { describe, it, expect } from "vitest"
import { toEventStatus } from "../../src/services/admin/event-status.js"
import { EventStatusSchema } from "@civfix/shared"

/**
 * The one-way bridge from the DERIVED public CleanupStatus (computed from scheduled_at/ends_at since
 * 0.46.0) to the admin EventStatus wire enum. A legacy value already stored in admin vocabulary, or
 * garbage, must still resolve to a valid EventStatus rather than escape as an invalid enum.
 */

describe("event-status mapping", () => {
  it("maps every derived CleanupStatus to its EventStatus", () => {
    expect(toEventStatus("active")).toBe("in_progress")
    expect(toEventStatus("done")).toBe("completed")
    expect(toEventStatus("upcoming")).toBe("upcoming")
    expect(toEventStatus("cancelled")).toBe("cancelled")
  })

  it("tolerates a legacy Phase-2 value stored in the column", () => {
    expect(toEventStatus("in_progress")).toBe("in_progress")
    expect(toEventStatus("completed")).toBe("completed")
    for (const stored of ["active", "done", "in_progress", "completed", "upcoming", "cancelled"]) {
      expect(EventStatusSchema.safeParse(toEventStatus(stored)).success).toBe(true)
    }
  })

  it("degrades an unknown value to the safe default, never an invalid enum", () => {
    expect(toEventStatus("garbage")).toBe("upcoming")
    expect(EventStatusSchema.safeParse(toEventStatus("garbage")).success).toBe(true)
  })
})
