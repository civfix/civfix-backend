import { describe, it, expect } from "vitest"
import { toEventStatus } from "../../src/services/admin/event-status.js"
import { EventStatusSchema } from "@civfix/shared"

/**
 * Unit tests for the one-way event-status bridge (event-status.ts), which maps the DERIVED public
 * CleanupStatus (0.46.0, computed from scheduled_at/ends_at) to the admin EventStatus wire enum. These
 * prove:
 *   - every derived CleanupStatus maps to a valid EventStatus, with the two renames;
 *   - a legacy or leaked Phase-2 value still resolves rather than escaping as an invalid enum;
 *   - garbage degrades to the safe default.
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
