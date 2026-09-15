/**
 * `registrationStateOf` after the status derivation (0.46.0, DECISIONS §40).
 *
 * Registration used to close on the stored `done` a host set by hand. Nothing writes that value any
 * more, so the gate is the clock: `cancelled` (the one stored decision) OR the event's end having
 * passed. An UNDERWAY event stays open — walk-ups are the whole point of the check-in desk.
 */

import { describe, expect, it } from "vitest"
import { registrationStateOf } from "../../../src/services/host/registration-dto.js"
import type { EventRegistrationContext } from "../../../src/services/host/registration-repository.types.js"

const NOW = new Date("2026-06-01T12:00:00.000Z")
const HOUR = 3_600_000

function event(
  over: Partial<Pick<EventRegistrationContext, "status" | "scheduledAt" | "endsAt">> = {},
): Pick<
  EventRegistrationContext,
  "status" | "scheduledAt" | "endsAt" | "registrationOpensAt" | "registrationClosesAt"
> {
  return {
    status: over.status ?? "upcoming",
    scheduledAt: over.scheduledAt ?? new Date(NOW.getTime() + HOUR),
    endsAt: over.endsAt === undefined ? new Date(NOW.getTime() + 5 * HOUR) : over.endsAt,
    registrationOpensAt: null,
    registrationClosesAt: null,
  }
}

describe("registrationStateOf", () => {
  it("is open before the event starts", () => {
    expect(registrationStateOf(event(), [], NOW)).toBe("open")
  })

  it("stays open while the event is UNDERWAY (walk-ups still register at the desk)", () => {
    const underway = event({
      scheduledAt: new Date(NOW.getTime() - HOUR),
      endsAt: new Date(NOW.getTime() + 3 * HOUR),
    })
    expect(registrationStateOf(underway, [], NOW)).toBe("open")
  })

  it("closes the instant the event's end passes", () => {
    const atTheEnd = event({
      scheduledAt: new Date(NOW.getTime() - 4 * HOUR),
      endsAt: NOW,
    })
    expect(registrationStateOf(atTheEnd, [], NOW)).toBe("closed")

    const past = event({
      scheduledAt: new Date(NOW.getTime() - 8 * HOUR),
      endsAt: new Date(NOW.getTime() - 4 * HOUR),
    })
    expect(registrationStateOf(past, [], NOW)).toBe("closed")
  })

  it("closes a cancelled event whatever the clock says", () => {
    expect(registrationStateOf(event({ status: "cancelled" }), [], NOW)).toBe("closed")
  })

  it("ignores a legacy stored 'done' on an event that has not ended", () => {
    expect(registrationStateOf(event({ status: "done" }), [], NOW)).toBe("open")
  })

  it("falls back to the 4 h default window when a legacy row carries no end", () => {
    const legacyOpen = event({ scheduledAt: new Date(NOW.getTime() - HOUR), endsAt: null })
    expect(registrationStateOf(legacyOpen, [], NOW)).toBe("open")

    const legacyClosed = event({ scheduledAt: new Date(NOW.getTime() - 5 * HOUR), endsAt: null })
    expect(registrationStateOf(legacyClosed, [], NOW)).toBe("closed")
  })
})
