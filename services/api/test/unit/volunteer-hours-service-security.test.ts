import { describe, expect, it } from "vitest"
import type { EventVisibility } from "@civfix/shared"
import {
  makeVolunteerHoursService,
  type CleanupHoursView,
  type VolunteerHoursService,
} from "../../src/services/volunteer-hours-service.js"
import { InMemoryVolunteerHoursRepository } from "../helpers/volunteer-hours-repository.memory.js"

const HOST = "11111111-1111-1111-1111-111111111111"
const MEMBER = "22222222-2222-2222-2222-222222222222"
const STRANGER = "33333333-3333-3333-3333-333333333333"
const CLEANUP = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

function endedEvent(visibility: EventVisibility): CleanupHoursView {
  return {
    organizerUserId: HOST,
    status: "done",
    visibility,
    jurisdictionGeoid: "0644000",
    title: "Quiet sweep",
    scheduledAt: new Date("2026-07-04T08:00:00.000Z"),
    endsAt: new Date("2026-07-04T12:00:00.000Z"),
    completedAt: new Date("2026-07-04T12:00:00.000Z"),
    timezone: null,
  }
}

function serviceFor(view: CleanupHoursView | null): VolunteerHoursService {
  return makeVolunteerHoursService({
    repo: new InMemoryVolunteerHoursRepository(),
    cleanups: {
      load: () => Promise.resolve(view),
      listMemberIds: () => Promise.resolve([HOST, MEMBER]),
      roleOf: (_cleanupId: string, userId: string) => {
        if (userId === HOST) return Promise.resolve("organizer" as const)
        if (userId === MEMBER) return Promise.resolve("member" as const)
        return Promise.resolve(null)
      },
    },
  })
}

async function rejectionOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
  } catch (err) {
    const { code, message } = err as { code: string; message: string }
    return { code, message }
  }
  throw new Error("expected the call to reject")
}

const logBy = (actorId: string) => ({
  cleanupId: CLEANUP,
  actorId,
  entries: [{ userId: MEMBER, hours: 2 }],
})

describe("event hours on a private event", () => {
  it("reads to a stranger exactly like an unknown event", async () => {
    const unknown = await rejectionOf(serviceFor(null).getEventHours(CLEANUP, STRANGER))

    const hidden = await rejectionOf(
      serviceFor(endedEvent("private")).getEventHours(CLEANUP, STRANGER),
    )

    expect(unknown.code).toBe("NOT_FOUND")
    expect(hidden).toEqual(unknown)
  })

  it("answers a stranger's hours log exactly like an unknown event", async () => {
    const unknown = await rejectionOf(serviceFor(null).logEventHours(logBy(STRANGER)))

    const hidden = await rejectionOf(
      serviceFor(endedEvent("private")).logEventHours(logBy(STRANGER)),
    )

    expect(hidden).toEqual(unknown)
  })

  it("keeps serving members and hosts of the private event", async () => {
    const service = serviceFor(endedEvent("private"))

    await expect(service.getEventHours(CLEANUP, MEMBER)).resolves.toMatchObject({ scope: "self" })
    await expect(service.getEventHours(CLEANUP, HOST)).resolves.toMatchObject({ scope: "all" })
    await expect(service.logEventHours(logBy(MEMBER))).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(service.logEventHours(logBy(HOST))).resolves.toMatchObject({ credited: 1 })
  })

  it("leaves public and unlisted events answering a stranger as before", async () => {
    for (const visibility of ["public", "unlisted"] as const) {
      const service = serviceFor(endedEvent(visibility))
      await expect(service.getEventHours(CLEANUP, STRANGER)).resolves.toEqual({
        scope: "self",
        entries: [],
      })
      await expect(service.logEventHours(logBy(STRANGER))).rejects.toMatchObject({
        code: "FORBIDDEN",
      })
    }
  })
})
