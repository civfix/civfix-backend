import { TEST_TICKET_SIGNER } from "../../helpers/ticket-signer.js"
import { beforeEach, describe, expect, it } from "vitest"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { InMemoryCleanupRepository } from "../../helpers/cleanups.js"
import { makeCleanupService, type CleanupService } from "../../../src/services/cleanup-service.js"

const MEMBER = "11111111-1111-4111-8111-111111111111"
const STRANGER = "22222222-2222-4222-8222-222222222222"

const DAY_MS = 24 * 60 * 60 * 1000

let repo: InMemoryCleanupRepository
let service: CleanupService
let presigned: string[]
let organizationId: string

const ANON = { userId: null }

function page(over: { when?: "upcoming" | "past"; cursor?: string | null; limit?: number } = {}) {
  return {
    when: over.when ?? ("upcoming" as const),
    cursor: over.cursor ?? null,
    limit: over.limit ?? 20,
  }
}

beforeEach(() => {
  repo = new InMemoryCleanupRepository()
  presigned = []
  repo.seedUser({ id: MEMBER, displayName: "Olive Organizer", handle: "olive" })
  repo.seedUser({ id: STRANGER, displayName: "Sam Stranger", handle: "sam" })
  const org = repo.seedOrganization({
    slug: "bct",
    name: "Ballona Creek Trust",
    logoKey: "logos/bct",
  })
  organizationId = org.id
  repo.seedOrgMember(org.id, MEMBER, "owner")
  service = makeCleanupService({
    tickets: TEST_TICKET_SIGNER,
    repo,
    counters: new InMemoryCounterStore(),
    presignEventMedia: (key) => {
      presigned.push(key)
      return Promise.resolve(`https://cdn.test/${key}`)
    },
  })
})

describe("listOrganizationEvents visibility", () => {
  it("404s an unknown slug", async () => {
    await expect(service.listOrganizationEvents("nope", ANON, page())).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("404s a deleted organization", async () => {
    repo.seedOrganization({ slug: "gone", deleted: true })
    await expect(service.listOrganizationEvents("gone", ANON, page())).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("404s a suspended organization for everyone but its own members", async () => {
    repo.seedOrganization({ id: organizationId, slug: "bct", suspended: true })
    await expect(service.listOrganizationEvents("bct", ANON, page())).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(
      service.listOrganizationEvents("bct", { userId: STRANGER }, page()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      service.listOrganizationEvents("bct", { userId: MEMBER }, page()),
    ).resolves.toMatchObject({ items: [] })
  })

  it("lists only public events of that organization", async () => {
    repo.seedCleanup({
      organizerUserId: MEMBER,
      organizationId,
      title: "Public sweep",
      scheduledAt: new Date(Date.now() + DAY_MS),
    })
    repo.seedCleanup({
      organizerUserId: MEMBER,
      organizationId,
      title: "Unlisted sweep",
      visibility: "unlisted",
      scheduledAt: new Date(Date.now() + DAY_MS),
    })
    repo.seedCleanup({
      organizerUserId: MEMBER,
      organizationId,
      title: "Private sweep",
      visibility: "private",
      scheduledAt: new Date(Date.now() + DAY_MS),
    })
    repo.seedCleanup({
      organizerUserId: MEMBER,
      organizationId,
      title: "Cancelled sweep",
      status: "cancelled",
      scheduledAt: new Date(Date.now() + DAY_MS),
    })
    repo.seedCleanup({
      organizerUserId: MEMBER,
      title: "Personal sweep",
      scheduledAt: new Date(Date.now() + DAY_MS),
    })

    const anon = await service.listOrganizationEvents("bct", ANON, page())
    expect(anon.items.map((i) => i.title)).toEqual(["Public sweep"])

    const member = await service.listOrganizationEvents("bct", { userId: MEMBER }, page())
    expect(member.items.map((i) => i.title)).toEqual(["Public sweep"])
  })

  it("matches the slug case-insensitively", async () => {
    await expect(service.listOrganizationEvents("BCT", ANON, page())).resolves.toMatchObject({
      items: [],
    })
  })
})

describe("listOrganizationEvents ordering and paging", () => {
  function seedAt(title: string, offsetMs: number): void {
    repo.seedCleanup({
      organizerUserId: MEMBER,
      organizationId,
      title,
      scheduledAt: new Date(Date.now() + offsetMs),
      ...(offsetMs < 0 ? { status: "done" as const } : {}),
    })
  }

  it("returns upcoming events soonest first and pages with a keyset cursor", async () => {
    seedAt("Third", 3 * DAY_MS)
    seedAt("First", DAY_MS)
    seedAt("Second", 2 * DAY_MS)

    const first = await service.listOrganizationEvents("bct", ANON, page({ limit: 2 }))
    expect(first.items.map((i) => i.title)).toEqual(["First", "Second"])
    expect(first.nextCursor).not.toBeNull()

    const second = await service.listOrganizationEvents(
      "bct",
      ANON,
      page({ limit: 2, cursor: first.nextCursor }),
    )
    expect(second.items.map((i) => i.title)).toEqual(["Third"])
    expect(second.nextCursor).toBeNull()
  })

  it("returns past events newest first", async () => {
    seedAt("Long ago", -30 * DAY_MS)
    seedAt("Recent", -2 * DAY_MS)
    seedAt("Upcoming", DAY_MS)

    const past = await service.listOrganizationEvents("bct", ANON, page({ when: "past" }))
    expect(past.items.map((i) => i.title)).toEqual(["Recent", "Long ago"])
  })
})

describe("listOrganizationEvents hydration", () => {
  it("presigns the organization logo once for the whole page", async () => {
    for (const title of ["A", "B", "C"]) {
      repo.seedCleanup({
        organizerUserId: MEMBER,
        organizationId,
        title,
        scheduledAt: new Date(Date.now() + DAY_MS),
      })
    }

    const listed = await service.listOrganizationEvents("bct", ANON, page())

    expect(listed.items).toHaveLength(3)
    for (const item of listed.items) {
      expect(item.organization).toMatchObject({
        slug: "bct",
        logoUrl: "https://cdn.test/logos/bct",
      })
    }
    expect(presigned.filter((key) => key === "logos/bct")).toHaveLength(1)
  })

  it("marks the viewer's own standing on each row", async () => {
    repo.seedCleanup({
      organizerUserId: MEMBER,
      organizationId,
      title: "Owned",
      scheduledAt: new Date(Date.now() + DAY_MS),
    })

    const stranger = await service.listOrganizationEvents("bct", { userId: STRANGER }, page())
    expect(stranger.items[0]?.joined).toBe(false)
    expect(stranger.items[0]?.myCapabilities).toEqual([])

    const owner = await service.listOrganizationEvents("bct", { userId: MEMBER }, page())
    expect(owner.items[0]?.joined).toBe(true)
    expect(owner.items[0]?.myCapabilities).toContain("manage_event")
  })
})
