import { describe, it, expect } from "vitest"
import {
  toEventStatus,
  toStoredCleanupStatus,
  storedVariantsForEventStatus,
} from "../../src/services/admin/event-status.js"
import { CLEANUP_STATUS_VALUES } from "../../src/db/schema/types.js"
import { EventStatusSchema } from "@civfix/shared"

/**
 * H1 unit tests for the single bidirectional event-status mapping (event-status.ts), the bridge between
 * the stored Phase-1 cleanups.status enum (upcoming|active|done|cancelled) and the Phase-2 EventStatus
 * wire enum (upcoming|in_progress|completed|cancelled). These prove:
 *   - DTO -> stored only ever yields a value inside the Phase-1 enum (so the drift guard never trips);
 *   - stored -> DTO maps both the Phase-1 values AND any leaked Phase-2 value to a valid EventStatus;
 *   - the round trip is stable for every EventStatus;
 *   - the completed filter matches the stored 'done' (the bug the review flagged).
 */

const EVENT_STATUSES = EventStatusSchema.options

describe("event-status mapping (H1)", () => {
  it("toStoredCleanupStatus only ever produces a Phase-1 cleanups.status value", () => {
    for (const status of EVENT_STATUSES) {
      const stored = toStoredCleanupStatus(status)
      expect(CLEANUP_STATUS_VALUES).toContain(stored)
    }
    // The specific Phase-2 -> Phase-1 renames.
    expect(toStoredCleanupStatus("in_progress")).toBe("active")
    expect(toStoredCleanupStatus("completed")).toBe("done")
    expect(toStoredCleanupStatus("upcoming")).toBe("upcoming")
    expect(toStoredCleanupStatus("cancelled")).toBe("cancelled")
  })

  it("toEventStatus maps the Phase-1 stored values to a valid EventStatus", () => {
    expect(toEventStatus("active")).toBe("in_progress")
    expect(toEventStatus("done")).toBe("completed")
    expect(toEventStatus("upcoming")).toBe("upcoming")
    expect(toEventStatus("cancelled")).toBe("cancelled")
  })

  it("toEventStatus tolerates a leaked Phase-2 value mis-stored in the column", () => {
    // A pre-fix admin build could have written a Phase-2 value straight into cleanups.status. The read
    // map must still resolve it to a valid EventStatus, never leak an invalid one.
    expect(toEventStatus("in_progress")).toBe("in_progress")
    expect(toEventStatus("completed")).toBe("completed")
    for (const stored of ["active", "done", "in_progress", "completed", "upcoming", "cancelled"]) {
      expect(EventStatusSchema.safeParse(toEventStatus(stored)).success).toBe(true)
    }
    // An unknown/garbage value degrades to the safe default, not an invalid enum.
    expect(toEventStatus("garbage")).toBe("upcoming")
    expect(EventStatusSchema.safeParse(toEventStatus("garbage")).success).toBe(true)
  })

  it("round-trips every EventStatus through the stored value unchanged", () => {
    for (const status of EVENT_STATUSES) {
      expect(toEventStatus(toStoredCleanupStatus(status))).toBe(status)
    }
  })

  it("the completed filter matches BOTH the stored 'done' and a leaked 'completed'", () => {
    expect(storedVariantsForEventStatus("completed")).toEqual(["done", "completed"])
    expect(storedVariantsForEventStatus("in_progress")).toEqual(["active", "in_progress"])
    expect(storedVariantsForEventStatus("upcoming")).toEqual(["upcoming"])
    expect(storedVariantsForEventStatus("cancelled")).toEqual(["cancelled"])
  })
})
