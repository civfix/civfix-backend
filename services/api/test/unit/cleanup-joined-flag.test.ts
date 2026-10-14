import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"
import { beforeEach, describe, expect, it } from "vitest"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import { makeCleanupService, type CleanupService } from "../../src/services/cleanup-service.js"

const ORGANIZER = "11111111-1111-4111-8111-111111111111"
const ORG_OWNER = "22222222-2222-4222-8222-222222222222"

const DAY_MS = 24 * 60 * 60 * 1000

let repo: InMemoryCleanupRepository
let service: CleanupService
let eventId: string

beforeEach(() => {
  repo = new InMemoryCleanupRepository()
  repo.seedUser({ id: ORGANIZER, displayName: "Olive Organizer", handle: "olive" })
  repo.seedUser({ id: ORG_OWNER, displayName: "Owen Owner", handle: "owen" })
  const org = repo.seedOrganization({ slug: "bct", name: "Ballona Creek Trust" })
  repo.seedOrgMember(org.id, ORGANIZER, "member")
  repo.seedOrgMember(org.id, ORG_OWNER, "owner")
  eventId = repo.seedCleanup({
    organizerUserId: ORGANIZER,
    organizationId: org.id,
    title: "Creek sweep",
    scheduledAt: new Date(Date.now() + DAY_MS),
  }).id
  service = makeCleanupService({
    tickets: TEST_TICKET_SIGNER,
    repo,
    counters: new InMemoryCounterStore(),
  })
})

describe("joined means the viewer RSVP'd, never that they can manage the event", () => {
  it("is false on the detail for an org owner who never RSVP'd, while they keep host powers", async () => {
    const detail = await service.getCleanup(eventId, { userId: ORG_OWNER })
    expect(detail.joined).toBe(false)
    expect(detail.myCapabilities).toContain("manage_event")
  })

  it("is false on the map list and the organization list for that org owner", async () => {
    const listed = await service.listCleanups({ when: "upcoming" } as never, { userId: ORG_OWNER })
    expect(listed.items.find((i) => i.id === eventId)?.joined).toBe(false)

    const org = await service.listOrganizationEvents(
      "bct",
      { userId: ORG_OWNER },
      { when: "upcoming", cursor: null, limit: 20 },
    )
    expect(org.items.find((i) => i.id === eventId)?.joined).toBe(false)
  })

  it("is false on the cancel response when an org owner cancels an event they did not RSVP to", async () => {
    const cancelled = await service.cancelCleanup(eventId, null, ORG_OWNER)
    expect(cancelled.joined).toBe(false)
  })

  it("stays true for the organizer, who is on the roster", async () => {
    const detail = await service.getCleanup(eventId, { userId: ORGANIZER })
    expect(detail.joined).toBe(true)
    const cancelled = await service.cancelCleanup(eventId, null, ORGANIZER)
    expect(cancelled.joined).toBe(true)
  })
})
