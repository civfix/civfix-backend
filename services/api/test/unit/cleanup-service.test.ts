import { describe, it, expect, beforeEach } from "vitest"
import { makeCleanupService, type CleanupService } from "../../src/services/cleanup-service.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import type { CreateCleanupRequest } from "@civfix/shared"

/**
 * Unit tests for the cleanup service over the in-memory CleanupRepository (no DB, no Docker). These
 * prove the Phase-1 cleanup behaviors:
 *   - create auto-joins the organizer and creates the membership atomically (membership == chat
 *     membership);
 *   - join/leave toggle membership + the going count, idempotently;
 *   - the organizer cannot leave their own cleanup;
 *   - list filters by when (upcoming/past) and bbox, and pages with a cursor;
 *   - getCleanup returns the DTO with the viewer's joined flag.
 */

const ORG = "11111111-1111-1111-1111-111111111111"
const ALICE = "22222222-2222-2222-2222-222222222222"
const BOB = "33333333-3333-3333-3333-333333333333"

let repo: InMemoryCleanupRepository
let service: CleanupService

function baseInput(over: Partial<CreateCleanupRequest> = {}): CreateCleanupRequest {
  return {
    title: over.title ?? "Beach cleanup",
    type: over.type ?? "site",
    eventKind: over.eventKind ?? "cleanup",
    ...(over.description !== undefined ? { description: over.description } : {}),
    ...(over.linkedReportIds !== undefined ? { linkedReportIds: over.linkedReportIds } : {}),
    lat: over.lat ?? 34.0,
    lng: over.lng ?? -118.49,
    scheduledAt: over.scheduledAt ?? new Date(Date.now() + 86_400_000).toISOString(),
    ...(over.bring !== undefined ? { bring: over.bring } : {}),
    ...(over.address !== undefined ? { address: over.address } : {}),
  }
}

beforeEach(() => {
  repo = new InMemoryCleanupRepository()
  repo.seedUser({ id: ORG, displayName: "Olive Organizer", handle: "olive" })
  service = makeCleanupService({ repo })
})

describe("createCleanup", () => {
  it("auto-joins the organizer and creates the membership atomically", async () => {
    const dto = await service.createCleanup(
      baseInput({ title: "Park sweep", bring: ["gloves", "bags"], address: "North gate" }),
      ORG,
    )

    // The DTO reflects the organizer auto-join.
    expect(dto.joined).toBe(true)
    expect(dto.going).toBe(1)
    expect(dto.status).toBe("upcoming")
    expect(dto.organizer.id).toBe(ORG)
    expect(dto.organizer.name).toBe("Olive Organizer")
    expect(dto.bring).toEqual(["gloves", "bags"])
    expect(dto.address).toBe("North gate")

    // The membership row exists (== chat membership), atomic with the cleanup row: both present.
    expect(repo.cleanups.has(dto.id)).toBe(true)
    expect(await repo.isMember(dto.id, ORG)).toBe(true)
    const organizerMembers = repo.members.filter((m) => m.cleanupId === dto.id && m.role === "organizer")
    expect(organizerMembers).toHaveLength(1)
  })

  it("echoes a null address when none is supplied", async () => {
    const dto = await service.createCleanup(baseInput(), ORG)
    expect(dto.address).toBeNull()
    expect(dto.bring).toEqual([])
  })
})

describe("joinCleanup / leaveCleanup", () => {
  it("join toggles membership and bumps the going count (idempotent)", async () => {
    const created = await service.createCleanup(baseInput(), ORG)

    const first = await service.joinCleanup(created.id, ALICE)
    expect(first).toEqual({ joined: true, going: 2 })
    expect(await repo.isMember(created.id, ALICE)).toBe(true)

    // Re-joining is a no-op: still one membership, going unchanged.
    const again = await service.joinCleanup(created.id, ALICE)
    expect(again).toEqual({ joined: true, going: 2 })
    expect(repo.members.filter((m) => m.cleanupId === created.id && m.userId === ALICE)).toHaveLength(1)
  })

  it("a member can leave; going drops and membership is removed", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    await service.joinCleanup(created.id, ALICE)

    const left = await service.leaveCleanup(created.id, ALICE)
    expect(left).toEqual({ joined: false, going: 1 })
    expect(await repo.isMember(created.id, ALICE)).toBe(false)
  })

  it("the organizer cannot leave their own cleanup (409 CONFLICT)", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    await expect(service.leaveCleanup(created.id, ORG)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    // Membership untouched.
    expect(await repo.isMember(created.id, ORG)).toBe(true)
  })

  it("joining a missing cleanup 404s", async () => {
    await expect(
      service.joinCleanup("00000000-0000-0000-0000-000000000000", ALICE),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("leaving a missing cleanup 404s", async () => {
    await expect(
      service.leaveCleanup("00000000-0000-0000-0000-000000000000", ALICE),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("getCleanup", () => {
  it("returns the DTO with joined=true for a member and false for a stranger", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    await service.joinCleanup(created.id, ALICE)

    const asAlice = await service.getCleanup(created.id, { userId: ALICE })
    expect(asAlice.joined).toBe(true)
    expect(asAlice.going).toBe(2)

    const asBob = await service.getCleanup(created.id, { userId: BOB })
    expect(asBob.joined).toBe(false)

    const asAnon = await service.getCleanup(created.id, { userId: null })
    expect(asAnon.joined).toBe(false)
  })

  it("404s a missing cleanup", async () => {
    await expect(
      service.getCleanup("00000000-0000-0000-0000-000000000000", { userId: null }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("listCleanups filters", () => {
  beforeEach(() => {
    // Freeze "now" so when-filters are deterministic.
    repo.now = () => new Date("2026-06-01T00:00:00.000Z")
  })

  it("filters by when=upcoming (future, not cancelled) vs past", async () => {
    // Seed three cleanups directly: future, past, and a cancelled future.
    repo.seedCleanup({
      id: "aaaaaaaa-0000-0000-0000-000000000001",
      organizerUserId: ORG,
      title: "Future",
      scheduledAt: new Date("2026-06-10T00:00:00.000Z"),
      status: "upcoming",
    })
    repo.seedCleanup({
      id: "aaaaaaaa-0000-0000-0000-000000000002",
      organizerUserId: ORG,
      title: "Past",
      scheduledAt: new Date("2026-05-10T00:00:00.000Z"),
      status: "done",
    })
    repo.seedCleanup({
      id: "aaaaaaaa-0000-0000-0000-000000000003",
      organizerUserId: ORG,
      title: "CancelledFuture",
      scheduledAt: new Date("2026-06-20T00:00:00.000Z"),
      status: "cancelled",
    })

    const upcoming = await service.listCleanups({ when: "upcoming" }, { userId: null })
    expect(upcoming.items.map((c) => c.title)).toEqual(["Future"])

    const past = await service.listCleanups({ when: "past" }, { userId: null })
    expect(past.items.map((c) => c.title)).toEqual(["Past"])

    // No when filter excludes only cancelled.
    const all = await service.listCleanups({}, { userId: null })
    expect(all.items.map((c) => c.title).sort()).toEqual(["Future", "Past"])
  })

  it("filters by bbox (point-in-envelope)", async () => {
    repo.seedCleanup({
      id: "bbbbbbbb-0000-0000-0000-000000000001",
      organizerUserId: ORG,
      title: "InBox",
      lat: 34.05,
      lng: -118.45,
      scheduledAt: new Date("2026-06-10T00:00:00.000Z"),
    })
    repo.seedCleanup({
      id: "bbbbbbbb-0000-0000-0000-000000000002",
      organizerUserId: ORG,
      title: "OutOfBox",
      lat: 40.0,
      lng: -74.0,
      scheduledAt: new Date("2026-06-10T00:00:00.000Z"),
    })

    const res = await service.listCleanups(
      { bbox: { west: -119, south: 33, east: -118, north: 35 } },
      { userId: null },
    )
    expect(res.items.map((c) => c.title)).toEqual(["InBox"])
  })

  it("marks joined per viewer in the list", async () => {
    const created = await service.createCleanup(
      baseInput({ scheduledAt: new Date("2026-06-10T00:00:00.000Z").toISOString() }),
      ORG,
    )
    await service.joinCleanup(created.id, ALICE)

    const asAlice = await service.listCleanups({ when: "upcoming" }, { userId: ALICE })
    expect(asAlice.items.find((c) => c.id === created.id)?.joined).toBe(true)

    const asBob = await service.listCleanups({ when: "upcoming" }, { userId: BOB })
    expect(asBob.items.find((c) => c.id === created.id)?.joined).toBe(false)
  })

  it("when=attending returns only the viewer's events (joined or hosted), soonest-first", async () => {
    repo.seedUser({ id: ALICE, displayName: "Alice", handle: "alice" })
    repo.seedUser({ id: BOB, displayName: "Bob", handle: "bob" })

    // Hosted by BOB; ALICE RSVPs to it (the soonest of ALICE's events).
    const rsvped = await service.createCleanup(
      baseInput({ title: "RSVP", scheduledAt: new Date("2026-06-05T00:00:00.000Z").toISOString() }),
      BOB,
    )
    await service.joinCleanup(rsvped.id, ALICE)
    // Hosted by ALICE: the organizer auto-joins, so "attending" must include a hosted event too.
    await service.createCleanup(
      baseInput({ title: "Hosted", scheduledAt: new Date("2026-06-08T00:00:00.000Z").toISOString() }),
      ALICE,
    )
    // Hosted by BOB, ALICE is NOT a member (and it is the soonest overall) -> must be excluded.
    await service.createCleanup(
      baseInput({ title: "Other", scheduledAt: new Date("2026-06-03T00:00:00.000Z").toISOString() }),
      BOB,
    )

    const attending = await service.listCleanups({ when: "attending" }, { userId: ALICE })
    expect(attending.items.map((c) => c.title)).toEqual(["RSVP", "Hosted"])

    // Anonymous viewers have no memberships -> empty (short-circuited before any query).
    const anon = await service.listCleanups({ when: "attending" }, { userId: null })
    expect(anon.items).toEqual([])
  })

  it("pages with a cursor (limit 1) over future cleanups", async () => {
    for (let i = 1; i <= 3; i++) {
      repo.seedCleanup({
        id: `cccccccc-0000-0000-0000-00000000000${i}`,
        organizerUserId: ORG,
        title: `C${i}`,
        // Distinct ascending times so the order is stable.
        scheduledAt: new Date(`2026-06-0${i}T00:00:00.000Z`),
        status: "upcoming",
      })
    }

    const page1 = await service.listCleanups({ when: "upcoming", limit: 1 }, { userId: null })
    expect(page1.items).toHaveLength(1)
    expect(page1.items[0]!.title).toBe("C1")
    expect(page1.nextCursor).not.toBeNull()

    const page2 = await service.listCleanups(
      { when: "upcoming", limit: 1, cursor: page1.nextCursor! },
      { userId: null },
    )
    expect(page2.items[0]!.title).toBe("C2")

    const page3 = await service.listCleanups(
      { when: "upcoming", limit: 1, cursor: page2.nextCursor! },
      { userId: null },
    )
    expect(page3.items[0]!.title).toBe("C3")
    expect(page3.nextCursor).toBeNull()
  })

  it("orders by distance when near is supplied", async () => {
    // Near point at (34.0, -118.49). Seed two cleanups at different distances.
    repo.seedCleanup({
      id: "dddddddd-0000-0000-0000-000000000001",
      organizerUserId: ORG,
      title: "Near",
      lat: 34.01,
      lng: -118.49,
      scheduledAt: new Date("2026-06-10T00:00:00.000Z"),
    })
    repo.seedCleanup({
      id: "dddddddd-0000-0000-0000-000000000002",
      organizerUserId: ORG,
      title: "Far",
      lat: 34.5,
      lng: -118.0,
      scheduledAt: new Date("2026-06-10T00:00:00.000Z"),
    })

    const res = await service.listCleanups(
      { near: { lat: 34.0, lng: -118.49 } },
      { userId: null },
    )
    expect(res.items.map((c) => c.title)).toEqual(["Near", "Far"])
    // The nearer one carries a smaller dist.
    expect(res.items[0]!.dist!).toBeLessThan(res.items[1]!.dist!)
  })
})

describe("listAttendees (who's going)", () => {
  const CAROL = "44444444-4444-4444-4444-444444444444"
  const VIC = "55555555-5555-5555-5555-555555555555"

  /** Organizer (auto-joined) + Alice/Bob/Carol RSVP'd. going === 4. All seeded so names resolve. */
  async function setupEvent() {
    repo.seedUser({ id: ALICE, displayName: "Alice" })
    repo.seedUser({ id: BOB, displayName: "Bob" })
    repo.seedUser({ id: CAROL, displayName: "Carol" })
    const created = await service.createCleanup(baseInput(), ORG)
    await service.joinCleanup(created.id, ALICE)
    await service.joinCleanup(created.id, BOB)
    await service.joinCleanup(created.id, CAROL)
    return created
  }

  it("a non-member sees only the attendees they follow (scope 'following'), with the full going count", async () => {
    const created = await setupEvent()
    // VIC follows Alice + Carol but has NOT RSVP'd (and does not follow the organizer or Bob).
    repo.seedFollow(VIC, ALICE)
    repo.seedFollow(VIC, CAROL)

    const res = await service.listAttendees(created.id, { userId: VIC })
    expect(res.scope).toBe("following")
    expect(res.going).toBe(4) // full member count, not the filtered roster length
    expect(res.attendees.map((p) => p.name)).toEqual(["Alice", "Carol"])
    expect(res.attendees.every((p) => p.isFollowing)).toBe(true)
  })

  it("an anonymous viewer sees no names but the real going count", async () => {
    const created = await setupEvent()
    const res = await service.listAttendees(created.id, { userId: null })
    expect(res.scope).toBe("following")
    expect(res.attendees).toEqual([])
    expect(res.going).toBe(4)
  })

  it("a member (RSVP'd) sees everyone going (scope 'all'), organizer first", async () => {
    const created = await setupEvent()
    const res = await service.listAttendees(created.id, { userId: ALICE })
    expect(res.scope).toBe("all")
    expect(res.going).toBe(4)
    expect(res.attendees.map((p) => p.name)).toEqual(["Olive Organizer", "Alice", "Bob", "Carol"])
  })

  it("the organizer always sees everyone (the organizer counts as joined)", async () => {
    const created = await setupEvent()
    const res = await service.listAttendees(created.id, { userId: ORG })
    expect(res.scope).toBe("all")
    expect(res.attendees.map((p) => p.name)).toEqual(["Olive Organizer", "Alice", "Bob", "Carol"])
  })

  it("marks isFollowing per attendee for a member viewer", async () => {
    const created = await setupEvent()
    repo.seedFollow(ALICE, BOB) // Alice (a member) follows Bob only.
    const res = await service.listAttendees(created.id, { userId: ALICE })
    const followingByName = Object.fromEntries(res.attendees.map((p) => [p.name, p.isFollowing]))
    expect(followingByName["Bob"]).toBe(true)
    expect(followingByName["Carol"]).toBe(false)
    expect(followingByName["Olive Organizer"]).toBe(false)
  })

  it("404s a missing cleanup", async () => {
    await expect(
      service.listAttendees("00000000-0000-0000-0000-000000000000", { userId: null }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})
