import { beforeEach, describe, expect, it } from "vitest"
import type { DuplicateCleanupRequest } from "@civfix/shared"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { InMemoryCleanupRepository } from "../../helpers/cleanups.js"
import {
  HOST_EVENTS_PER_DAY,
  makeCleanupService,
  type CleanupService,
} from "../../../src/services/cleanup-service.js"
import { DuplicateCleanupBodySchema } from "../../../src/routes/cleanups.routes.js"

const ORG = "11111111-1111-4111-8111-111111111111"
const COHOST = "22222222-2222-4222-8222-222222222222"
const OUTSIDER = "33333333-3333-4333-8333-333333333333"

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

let repo: InMemoryCleanupRepository
let service: CleanupService

function futureIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

function request(over: Partial<DuplicateCleanupRequest> & { id: string }): DuplicateCleanupRequest {
  return {
    scheduledAt: futureIso(7 * DAY_MS),
    includeTicketTypes: true,
    includeQuestions: true,
    includePage: false,
    ...over,
  }
}

function seedSource(over: Parameters<InMemoryCleanupRepository["seedCleanup"]>[0] = {}) {
  return repo.seedCleanup({
    organizerUserId: ORG,
    title: "Ballona sweep",
    description: "Bring boots",
    address: "North gate",
    bring: ["gloves", "bags"],
    scheduledAt: new Date(Date.now() + DAY_MS),
    endsAt: new Date(Date.now() + DAY_MS + 3 * HOUR_MS),
    timezone: "America/Los_Angeles",
    visibility: "public",
    reminderOffsetsMin: [1440],
    pageSlug: "ballona-sweep",
    referenceCode: "EV-0001",
    withDefaultSlot: false,
    ...over,
  })
}

beforeEach(() => {
  repo = new InMemoryCleanupRepository()
  repo.seedUser({ id: ORG, displayName: "Olive Organizer", handle: "olive" })
  repo.seedUser({ id: COHOST, displayName: "Cody Cohost", handle: "cody" })
  repo.seedUser({ id: OUTSIDER, displayName: "Sam Outsider", handle: "sam" })
  service = makeCleanupService({ repo, counters: new InMemoryCounterStore() })
})

describe("duplicateCleanup authorization", () => {
  it("refuses a viewer with no host standing", async () => {
    const source = seedSource()
    await expect(
      service.duplicateCleanup(OUTSIDER, request({ id: source.id })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("hides a non-public event from a viewer with no standing", async () => {
    const source = seedSource({ visibility: "private" })
    await expect(
      service.duplicateCleanup(OUTSIDER, request({ id: source.id })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("lets a cohost duplicate, and makes them the organizer of the copy", async () => {
    const source = seedSource()
    repo.seedMember(source.id, COHOST, "cohost")
    const copy = await service.duplicateCleanup(COHOST, request({ id: source.id }))
    expect(copy.organizer.id).toBe(COHOST)
    expect(copy.myRole).toBe("organizer")
  })

  it("counts against the host event budget", async () => {
    const source = seedSource()
    for (let i = 0; i < HOST_EVENTS_PER_DAY; i += 1) {
      await service.duplicateCleanup(ORG, request({ id: source.id }))
    }
    await expect(service.duplicateCleanup(ORG, request({ id: source.id }))).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
  })
})

describe("duplicateCleanup content", () => {
  it("copies the event content and resets what identifies the original", async () => {
    const source = seedSource()
    repo.seedSlot({ cleanupId: source.id, title: "Sign-in table", capacity: 2, sortOrder: 1 })
    repo.seedMember(source.id, OUTSIDER, "member")
    const scheduledAt = futureIso(9 * DAY_MS)

    const copy = await service.duplicateCleanup(ORG, request({ id: source.id, scheduledAt }))

    expect(copy.id).not.toBe(source.id)
    expect(copy.title).toBe("Ballona sweep")
    expect(copy.description).toBe("Bring boots")
    expect(copy.address).toBe("North gate")
    expect(copy.bring).toEqual(["gloves", "bags"])
    expect(copy.timezone).toBe("America/Los_Angeles")
    expect(copy.visibility).toBe("public")
    expect(copy.reminderOffsetsMinutes).toEqual([1440])
    expect(copy.slots.map((s) => s.title)).toEqual(["Sign-in table"])
    expect(copy.slots[0]?.claimed).toBe(0)

    expect(copy.scheduledAt).toBe(scheduledAt)
    expect(copy.pageSlug).toBeNull()
    expect(copy.status).toBe("upcoming")
    expect(copy.referenceCode).not.toBe("EV-0001")
    expect(copy.going).toBe(1)
    expect(repo.members.filter((m) => m.cleanupId === copy.id)).toHaveLength(1)
  })

  it("carries the source duration onto the new start time", async () => {
    const source = seedSource()
    const scheduledAt = futureIso(9 * DAY_MS)
    const copy = await service.duplicateCleanup(ORG, request({ id: source.id, scheduledAt }))
    expect(copy.endsAt).toBe(new Date(Date.parse(scheduledAt) + 3 * HOUR_MS).toISOString())
  })

  it("honours an explicit end time", async () => {
    const source = seedSource()
    const scheduledAt = futureIso(9 * DAY_MS)
    const endsAt = new Date(Date.parse(scheduledAt) + HOUR_MS).toISOString()
    const copy = await service.duplicateCleanup(
      ORG,
      request({ id: source.id, scheduledAt, endsAt }),
    )
    expect(copy.endsAt).toBe(endsAt)
  })

  it("carries a shift's WINDOW onto the copy, shifted by the same delta as the start (#109)", async () => {
    const source = seedSource()
    const sourceStart = repo.cleanups.get(source.id)!.scheduledAt
    repo.seedSlot({
      cleanupId: source.id,
      title: "Morning sweep",
      startsAt: new Date(sourceStart.getTime() + HOUR_MS),
      endsAt: new Date(sourceStart.getTime() + 2 * HOUR_MS),
    })
    const scheduledAt = futureIso(9 * DAY_MS)
    const delta = Date.parse(scheduledAt) - sourceStart.getTime()

    const copy = await service.duplicateCleanup(ORG, request({ id: source.id, scheduledAt }))

    expect(copy.slots.map((s) => [s.startsAt, s.endsAt])).toEqual([
      [
        new Date(sourceStart.getTime() + HOUR_MS + delta).toISOString(),
        new Date(sourceStart.getTime() + 2 * HOUR_MS + delta).toISOString(),
      ],
    ])
  })

  it("leaves an untimed role untimed on the copy", async () => {
    const source = seedSource()
    repo.seedSlot({ cleanupId: source.id, title: "Grill" })
    const copy = await service.duplicateCleanup(ORG, request({ id: source.id }))
    expect(copy.slots[0]?.startsAt).toBeUndefined()
    expect(copy.slots[0]?.endsAt).toBeUndefined()
  })

  it("422s a duplicate whose explicit endsAt is shorter than the shifted shifts need", async () => {
    const source = seedSource()
    const sourceStart = repo.cleanups.get(source.id)!.scheduledAt
    repo.seedSlot({
      cleanupId: source.id,
      title: "Afternoon sweep",
      startsAt: new Date(sourceStart.getTime() + 2 * HOUR_MS),
      endsAt: new Date(sourceStart.getTime() + 3 * HOUR_MS),
    })
    const scheduledAt = futureIso(9 * DAY_MS)
    const endsAt = new Date(Date.parse(scheduledAt) + HOUR_MS).toISOString()

    await expect(
      service.duplicateCleanup(ORG, request({ id: source.id, scheduledAt, endsAt })),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { slots: `slot "Afternoon sweep" falls outside the event's start and end` },
    })
  })

  it("keeps registration windows that are still ahead and drops the ones that are not", async () => {
    const opensAt = new Date(Date.now() + 2 * DAY_MS)
    const source = seedSource({
      registrationOpensAt: new Date(Date.now() - DAY_MS),
      registrationClosesAt: opensAt,
    })
    const copy = await service.duplicateCleanup(ORG, request({ id: source.id }))
    expect(copy.registrationOpensAt).toBeNull()
    expect(copy.registrationClosesAt).toBe(opensAt.toISOString())
  })

  it("carries no cover or gallery media (media binds to one event)", async () => {
    const source = seedSource({
      coverMediaId: "44444444-4444-4444-8444-444444444444",
      galleryMediaIds: ["55555555-5555-4555-8555-555555555555"],
    })
    const copy = await service.duplicateCleanup(ORG, request({ id: source.id }))
    expect(copy.coverUrl).toBeNull()
    expect(copy.galleryUrls).toEqual([])
    expect(repo.cleanups.get(copy.id)?.coverMediaId).toBeNull()
    expect(repo.cleanups.get(copy.id)?.galleryMediaIds).toEqual([])
  })
})

describe("duplicateCleanup organization link", () => {
  it("keeps the organization when the actor can still host for it", async () => {
    const org = repo.seedOrganization({ slug: "bct", name: "Ballona Creek Trust" })
    repo.seedOrgMember(org.id, ORG, "owner")
    const source = seedSource({ organizationId: org.id })
    const copy = await service.duplicateCleanup(ORG, request({ id: source.id }))
    expect(copy.organization).toMatchObject({ id: org.id, slug: "bct" })
  })

  it("creates an unlinked copy when the actor can no longer host for the organization", async () => {
    const org = repo.seedOrganization({ slug: "bct" })
    const source = seedSource({ organizationId: org.id })
    repo.seedMember(source.id, COHOST, "cohost")
    const copy = await service.duplicateCleanup(COHOST, request({ id: source.id }))
    expect(copy.organization).toBeNull()
  })

  it("creates an unlinked copy when the organization is suspended", async () => {
    const org = repo.seedOrganization({ slug: "bct", suspended: true })
    repo.seedOrgMember(org.id, ORG, "owner")
    const source = seedSource({ organizationId: org.id })
    const copy = await service.duplicateCleanup(ORG, request({ id: source.id }))
    expect(copy.organization).toBeNull()
  })

  it("keeps a donation link only while the actor may manage payments", async () => {
    const org = repo.seedOrganization({
      slug: "bct",
      verifiedStatus: "verified",
      verifiedKind: "nonprofit",
    })
    repo.seedOrgMember(org.id, ORG, "owner")
    repo.seedOrgMember(org.id, COHOST, "admin")
    const source = seedSource({
      organizationId: org.id,
      donationUrl: "https://give.example.org/bct",
    })
    repo.seedMember(source.id, COHOST, "cohost")

    const byOwner = await service.duplicateCleanup(ORG, request({ id: source.id }))
    expect(byOwner.donationUrl).toBe("https://give.example.org/bct")

    const byAdmin = await service.duplicateCleanup(COHOST, request({ id: source.id }))
    expect(byAdmin.organization).toMatchObject({ id: org.id })
    expect(byAdmin.donationUrl).toBeNull()
  })
})

describe("duplicateCleanup include flags", () => {
  it("copies ticket types with fresh ids and no reserved seats", async () => {
    const source = seedSource()
    repo.seedTicketType({
      cleanupId: source.id,
      name: "General admission",
      capacity: 40,
      reservedSeats: 12,
      salesOpensAt: new Date(Date.now() - DAY_MS),
      salesClosesAt: new Date(Date.now() + 3 * DAY_MS),
      accessCodeHash: "hash",
    })

    const copy = await service.duplicateCleanup(ORG, request({ id: source.id }))

    const copied = repo.ticketTypes.filter((t) => t.cleanupId === copy.id)
    expect(copied).toHaveLength(1)
    expect(copied[0]).toMatchObject({
      name: "General admission",
      capacity: 40,
      reservedSeats: 0,
      salesOpensAt: null,
      accessCodeHash: "hash",
    })
    expect(copied[0]?.id).not.toBe(repo.ticketTypes[0]?.id)
  })

  it("remaps question ticket types and conditions, and skips archived questions", async () => {
    const source = seedSource()
    const type = repo.seedTicketType({ cleanupId: source.id, name: "Crew" })
    const gate = repo.seedQuestion({ cleanupId: source.id, prompt: "Driving?" })
    repo.seedQuestion({
      cleanupId: source.id,
      prompt: "Plate number",
      ticketTypeId: type.id,
      showIfQuestionId: gate.id,
    })
    repo.seedQuestion({ cleanupId: source.id, prompt: "Retired", archived: true })

    const copy = await service.duplicateCleanup(ORG, request({ id: source.id }))

    const copied = repo.questions.filter((q) => q.cleanupId === copy.id)
    expect(copied.map((q) => q.prompt).sort()).toEqual(["Driving?", "Plate number"])
    const plate = copied.find((q) => q.prompt === "Plate number")
    const driving = copied.find((q) => q.prompt === "Driving?")
    const copiedType = repo.ticketTypes.find((t) => t.cleanupId === copy.id)
    expect(plate?.ticketTypeId).toBe(copiedType?.id)
    expect(plate?.ticketTypeId).not.toBe(type.id)
    expect(plate?.showIfQuestionId).toBe(driving?.id)
    expect(plate?.showIfQuestionId).not.toBe(gate.id)
  })

  it("drops ticket types and questions when the flags are off", async () => {
    const source = seedSource()
    repo.seedTicketType({ cleanupId: source.id, name: "Crew" })
    repo.seedQuestion({ cleanupId: source.id, prompt: "Driving?" })

    const copy = await service.duplicateCleanup(
      ORG,
      request({ id: source.id, includeTicketTypes: false, includeQuestions: false }),
    )

    expect(repo.ticketTypes.filter((t) => t.cleanupId === copy.id)).toHaveLength(0)
    expect(repo.questions.filter((q) => q.cleanupId === copy.id)).toHaveLength(0)
  })

  it("detaches a question from a ticket type that was not copied", async () => {
    const source = seedSource()
    const type = repo.seedTicketType({ cleanupId: source.id, name: "Crew" })
    repo.seedQuestion({ cleanupId: source.id, prompt: "Plate number", ticketTypeId: type.id })

    const copy = await service.duplicateCleanup(
      ORG,
      request({ id: source.id, includeTicketTypes: false }),
    )

    const copied = repo.questions.filter((q) => q.cleanupId === copy.id)
    expect(copied).toHaveLength(1)
    expect(copied[0]?.ticketTypeId).toBeNull()
  })

  it("leaves the event page behind unless it is asked for", async () => {
    const source = seedSource()
    repo.seedPage({
      cleanupId: source.id,
      status: "published",
      blocks: [{ id: "hero", kind: "hero", headline: "Join us", mediaId: "abc" }],
    })

    const without = await service.duplicateCleanup(ORG, request({ id: source.id }))
    expect(repo.pages.filter((p) => p.cleanupId === without.id)).toHaveLength(0)

    const withPage = await service.duplicateCleanup(
      ORG,
      request({ id: source.id, includePage: true }),
    )
    const page = repo.pages.find((p) => p.cleanupId === withPage.id)
    expect(page?.status).toBe("draft")
    expect(page?.blocks).toEqual([{ id: "hero", kind: "hero", headline: "Join us" }])
  })
})

describe("DuplicateCleanupBodySchema", () => {
  const id = "11111111-1111-4111-8111-111111111111"

  it("defaults the include flags the way the contract does", () => {
    const parsed = DuplicateCleanupBodySchema.parse({ id, scheduledAt: futureIso(DAY_MS) })
    expect(parsed).toMatchObject({
      includeTicketTypes: true,
      includeQuestions: true,
      includePage: false,
    })
  })

  it("refuses a start time in the past", () => {
    const result = DuplicateCleanupBodySchema.safeParse({
      id,
      scheduledAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
    })
    expect(result.success).toBe(false)
  })

  it("refuses unknown fields", () => {
    const result = DuplicateCleanupBodySchema.safeParse({
      id,
      scheduledAt: futureIso(DAY_MS),
      includeRegistrations: true,
    })
    expect(result.success).toBe(false)
  })
})
