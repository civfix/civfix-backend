import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"
import { beforeEach, describe, expect, it } from "vitest"
import { FakeJobs } from "@civfix/shared/fakes"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import { makeCleanupService, type CleanupService } from "../../src/services/cleanup-service.js"
import { CLEANUP_GUEST_UPDATE_FANOUT_JOB } from "../../src/lib/queue-names.js"

const ORG = "11111111-1111-1111-1111-111111111111"

let repo: InMemoryCleanupRepository
let jobs: FakeJobs
let service: CleanupService
let eventId: string

beforeEach(async () => {
  repo = new InMemoryCleanupRepository()
  repo.seedUser({ id: ORG, displayName: "Olive Organizer", handle: "olive" })
  jobs = new FakeJobs()
  service = makeCleanupService({
    tickets: TEST_TICKET_SIGNER,
    repo,
    counters: new InMemoryCounterStore(),
    jobs,
  })
  const created = await service.createCleanup(
    {
      title: "Beach cleanup",
      type: "site",
      eventKind: "cleanup",
      lat: 34.0,
      lng: -118.49,
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      slots: [{ title: "Volunteers" }],
    },
    ORG,
  )
  eventId = created.id
})

describe("a PATCH carrying only one coordinate does not move the event", () => {
  it("leaves the pin where it was and tells no guest about a move that never happened", async () => {
    await service.updateCleanup(eventId, { lat: 35.5 }, ORG)

    const stored = await repo.findCleanupById(eventId, null)
    expect(stored?.lat).toBe(34.0)
    expect(stored?.lng).toBe(-118.49)
    expect(jobs.jobsFor(CLEANUP_GUEST_UPDATE_FANOUT_JOB)).toHaveLength(0)
  })

  it("still moves the event and notifies guests when both coordinates change", async () => {
    await service.updateCleanup(eventId, { lat: 35.5, lng: -118.3 }, ORG)

    const stored = await repo.findCleanupById(eventId, null)
    expect(stored?.lat).toBe(35.5)
    expect(stored?.lng).toBe(-118.3)
    expect(jobs.jobsFor(CLEANUP_GUEST_UPDATE_FANOUT_JOB)).toHaveLength(1)
  })
})
