import { describe, it, expect, beforeEach } from "vitest"
import { FakeJobs } from "@civfix/shared/fakes"
import {
  makeCleanupService,
  CLEANUP_CANCEL_FANOUT_JOB,
  ATTENDEES_DEFAULT_LIMIT,
  MAX_BRING_ITEMS,
  RESOURCE_REQUEST_PER_HOST_PER_DAY,
  RESOURCE_REQUEST_PER_JURISDICTION_PER_HOUR,
  ROLE_CHANGES_PER_TARGET_PER_WINDOW,
  MEMBERSHIP_FLIPS_PER_EVENT_PER_WINDOW,
  type CleanupService,
} from "../../src/services/cleanup-service.js"
import { CLEANUP_GUEST_UPDATE_FANOUT_JOB } from "../../src/services/guest-rsvp-service.js"
import { IN_PROGRESS_GRACE_HOURS } from "../../src/services/cleanup-rules.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import type { CreateCleanupRequest } from "@civfix/shared"


const ORG = "11111111-1111-1111-1111-111111111111"
const ALICE = "22222222-2222-2222-2222-222222222222"
const BOB = "33333333-3333-3333-3333-333333333333"

const PAST = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()

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
    ...(over.organizationId !== undefined ? { organizationId: over.organizationId } : {}),
  }
}

beforeEach(() => {
  repo = new InMemoryCleanupRepository()
  repo.seedUser({ id: ORG, displayName: "Olive Organizer", handle: "olive" })
  service = makeCleanupService({ repo, counters: new InMemoryCounterStore() })
})

describe("createCleanup", () => {
  it("auto-joins the organizer and creates the membership atomically", async () => {
    const dto = await service.createCleanup(
      baseInput({ title: "Park sweep", bring: ["gloves", "bags"], address: "North gate" }),
      ORG,
    )

    expect(dto.joined).toBe(true)
    expect(dto.going).toBe(1)
    expect(dto.status).toBe("upcoming")
    expect(dto.organizer.id).toBe(ORG)
    expect(dto.organizer.name).toBe("Olive Organizer")
    expect(dto.bring).toEqual(["gloves", "bags"])
    expect(dto.address).toBe("North gate")

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

  it("mints an EVENT reference code (unknown bucket without a jurisdiction resolver)", async () => {
    const dto = await service.createCleanup(baseInput(), ORG)
    expect(dto.referenceCode).toMatch(/^EVENT-0-\d{6}$/)
    expect(dto.jurisdictionGeoid).toBeUndefined()
  })

  it("resolves the event's jurisdiction + code and getCleanup resolves by reference_code", async () => {
    const scoped = makeCleanupService({
      counters: new InMemoryCounterStore(),
      repo,
      resolveJurisdictionGeoid: () => Promise.resolve("0644000"),
      resolveJurisdictionCode: () => Promise.resolve(42),
    })
    const created = await scoped.createCleanup(baseInput(), ORG)
    expect(created.jurisdictionGeoid).toBe("0644000")
    expect(created.referenceCode).toMatch(/^EVENT-42-\d{6}$/)

    const byCode = await scoped.getCleanup(created.referenceCode!, { userId: ORG })
    expect(byCode.id).toBe(created.id)
    expect(byCode.referenceCode).toBe(created.referenceCode)
  })
})

describe("joinCleanup / leaveCleanup", () => {
  it("join toggles membership and bumps the going count (idempotent)", async () => {
    const created = await service.createCleanup(baseInput(), ORG)

    const first = await service.joinCleanup(created.id, ALICE)
    expect(first).toEqual({ joined: true, going: 2 })
    expect(await repo.isMember(created.id, ALICE)).toBe(true)

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

  it(`H12: caps join/leave flips at ${MEMBERSHIP_FLIPS_PER_EVENT_PER_WINDOW} per attendee per event`, async () => {
    const counters = new InMemoryCounterStore()
    const scoped = makeCleanupService({ repo, counters })
    const created = await scoped.createCleanup(baseInput(), ORG)

    for (let i = 0; i < MEMBERSHIP_FLIPS_PER_EVENT_PER_WINDOW; i++) {
      if (i % 2 === 0) await scoped.joinCleanup(created.id, ALICE)
      else await scoped.leaveCleanup(created.id, ALICE)
    }
    await expect(scoped.joinCleanup(created.id, ALICE)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
    await expect(scoped.leaveCleanup(created.id, ALICE)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })

    const other = await scoped.createCleanup(baseInput(), ORG)
    await expect(scoped.joinCleanup(other.id, ALICE)).resolves.toMatchObject({ joined: true })
    await expect(scoped.joinCleanup(created.id, BOB)).resolves.toMatchObject({ joined: true })
  })

  it("refuses to join an event whose endsAt is in the past (409 CONFLICT)", async () => {
    const created = await service.createCleanup(baseInput({ scheduledAt: PAST }), ORG)
    repo.cleanups.get(created.id)!.endsAt = new Date(Date.now() - 60 * 60 * 1000)

    await expect(service.joinCleanup(created.id, ALICE)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This event has already ended.",
    })
    expect(await repo.isMember(created.id, ALICE)).toBe(false)
  })

  it("refuses to join when endsAt is null and the start is older than the grace window", async () => {
    const stale = new Date(Date.now() - (IN_PROGRESS_GRACE_HOURS + 1) * 60 * 60 * 1000)
    const created = await service.createCleanup(
      baseInput({ scheduledAt: stale.toISOString() }),
      ORG,
    )
    repo.cleanups.get(created.id)!.scheduledAt = stale

    await expect(service.joinCleanup(created.id, ALICE)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This event has already ended.",
    })
    expect(await repo.isMember(created.id, ALICE)).toBe(false)
  })

  it("still accepts a join for an event that started an hour ago with no endsAt", async () => {
    const created = await service.createCleanup(baseInput({ scheduledAt: PAST }), ORG)
    repo.cleanups.get(created.id)!.scheduledAt = new Date(Date.now() - 60 * 60 * 1000)

    await expect(service.joinCleanup(created.id, ALICE)).resolves.toEqual({
      joined: true,
      going: 2,
    })
  })

  it("lets an attendee leave an event that has already ended", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    await service.joinCleanup(created.id, ALICE)
    repo.cleanups.get(created.id)!.endsAt = new Date(Date.now() - 60 * 60 * 1000)
    repo.cleanups.get(created.id)!.scheduledAt = new Date(Date.now() - 3 * 60 * 60 * 1000)

    await expect(service.leaveCleanup(created.id, ALICE)).resolves.toEqual({
      joined: false,
      going: 1,
    })
    expect(await repo.isMember(created.id, ALICE)).toBe(false)
  })

  it("a completed or cancelled event still reports the closed message, not the ended one", async () => {
    const done = await service.createCleanup(baseInput({ scheduledAt: PAST }), ORG)
    repo.cleanups.get(done.id)!.status = "done"
    await expect(service.joinCleanup(done.id, ALICE)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This event is closed.",
    })

    const cancelled = await service.createCleanup(baseInput(), ORG)
    repo.cleanups.get(cancelled.id)!.status = "cancelled"
    await expect(service.joinCleanup(cancelled.id, ALICE)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This event is closed.",
    })
  })
})

describe("cancelCleanup", () => {
  it("the organizer cancels: status flips to 'cancelled' and a 'cancel' timeline row is written", async () => {
    const created = await service.createCleanup(baseInput(), ORG)

    const dto = await service.cancelCleanup(created.id, null, ORG)
    expect(dto.status).toBe("cancelled")
    expect(repo.cleanups.get(created.id)?.status).toBe("cancelled")
    const cancelRows = repo.timeline.filter((t) => t.cleanupId === created.id && t.kind === "cancel")
    expect(cancelRows).toHaveLength(1)
    expect(cancelRows[0]!.actorId).toBe(ORG)
  })

  it("records the trimmed reason on the timeline note when supplied", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    const dto = await service.cancelCleanup(created.id, "  Storm warning  ", ORG)
    expect(dto.status).toBe("cancelled")
  })

  it("403s a non-organizer (host gate)", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    await expect(service.cancelCleanup(created.id, null, ALICE)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    expect(repo.cleanups.get(created.id)?.status).toBe("upcoming")
  })

  it("404s a missing cleanup", async () => {
    await expect(
      service.cancelCleanup("00000000-0000-0000-0000-000000000000", null, ORG),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("B18: 409s cancelling an event the host has already COMPLETED, and writes nothing", async () => {
    const created = await service.createCleanup(baseInput({ scheduledAt: PAST }), ORG)
    await service.completeCleanup(created.id, null, ORG)

    await expect(service.cancelCleanup(created.id, "changed my mind", ORG)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(repo.cleanups.get(created.id)?.status).toBe("done")
    expect(repo.timeline.filter((t) => t.cleanupId === created.id && t.kind === "cancel")).toEqual([])
  })

  it("F067: a completed event's date/title/location/type are frozen; cosmetic edits still apply", async () => {
    const created = await service.createCleanup(baseInput({ scheduledAt: PAST }), ORG)
    await service.completeCleanup(created.id, null, ORG)

    const future = new Date(Date.now() + 30 * 86_400_000).toISOString()
    await expect(
      service.updateCleanup(created.id, { scheduledAt: future }, ORG),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(
      service.updateCleanup(created.id, { title: "Retitled after the fact" }, ORG),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(
      service.updateCleanup(created.id, { lat: 40.0, lng: -74.0 }, ORG),
    ).rejects.toMatchObject({ code: "CONFLICT" })

    const ok = await service.updateCleanup(created.id, { description: "post-event notes" }, ORG)
    expect(ok.status).toBe("done")
    expect(ok.description).toBe("post-event notes")
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

  it("carries the organizer's custom profile picture, and omits it when they have none", async () => {
    repo.seedUser({ id: ORG, displayName: "Olive Organizer", avatarUrl: "https://cdn.test/o.jpg" })
    const withPhoto = await service.createCleanup(baseInput(), ORG)
    expect((await service.getCleanup(withPhoto.id, { userId: null })).organizer.avatarUrl).toBe(
      "https://cdn.test/o.jpg",
    )

    repo.seedUser({ id: ALICE, displayName: "Alice" })
    const withoutPhoto = await service.createCleanup(baseInput(), ALICE)
    const dto = await service.getCleanup(withoutPhoto.id, { userId: null })
    expect(dto.organizer).not.toHaveProperty("avatarUrl")
  })
})

describe("listCleanups filters", () => {
  beforeEach(() => {
    repo.now = () => new Date("2026-06-01T00:00:00.000Z")
  })

  it("filters by when=upcoming (future, not cancelled) vs past", async () => {
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

    const all = await service.listCleanups({}, { userId: null })
    expect(all.items.map((c) => c.title).sort()).toEqual(["Future", "Past"])
  })

  it("keeps an in-progress event in the upcoming list after its start time passes", async () => {
    repo.seedCleanup({
      id: "aaaaaaaa-0000-0000-0000-000000000021",
      organizerUserId: ORG,
      title: "InProgress",
      scheduledAt: new Date("2026-05-31T18:00:00.000Z"),
      status: "active",
    })
    repo.seedCleanup({
      id: "aaaaaaaa-0000-0000-0000-000000000022",
      organizerUserId: ORG,
      title: "StalePlanned",
      scheduledAt: new Date("2026-05-31T18:00:00.000Z"),
      status: "upcoming",
    })

    const upcoming = await service.listCleanups({ when: "upcoming" }, { userId: null })
    expect(upcoming.items.map((c) => c.title)).toEqual(["InProgress"])
  })

  it("drops a stale in-progress event once it falls outside the grace window", async () => {
    repo.seedCleanup({
      id: "aaaaaaaa-0000-0000-0000-000000000028",
      organizerUserId: ORG,
      title: "StaleActive",
      scheduledAt: new Date("2026-05-28T00:00:00.000Z"),
      status: "active",
    })
    repo.seedCleanup({
      id: "aaaaaaaa-0000-0000-0000-000000000029",
      organizerUserId: ORG,
      title: "RecentActive",
      scheduledAt: new Date("2026-05-31T18:00:00.000Z"),
      status: "active",
    })

    const upcoming = await service.listCleanups({ when: "upcoming" }, { userId: null })
    expect(upcoming.items.map((c) => c.title)).toEqual(["RecentActive"])
  })

  it("drops a finished event from the upcoming list even when it is future-dated", async () => {
    repo.seedCleanup({
      id: "aaaaaaaa-0000-0000-0000-000000000023",
      organizerUserId: ORG,
      title: "FinishedButFutureDated",
      scheduledAt: new Date("2026-06-15T00:00:00.000Z"),
      status: "done",
    })
    repo.seedCleanup({
      id: "aaaaaaaa-0000-0000-0000-000000000024",
      organizerUserId: ORG,
      title: "StillPlanned",
      scheduledAt: new Date("2026-06-15T00:00:00.000Z"),
      status: "upcoming",
    })

    const upcoming = await service.listCleanups({ when: "upcoming" }, { userId: null })
    expect(upcoming.items.map((c) => c.title)).toEqual(["StillPlanned"])
  })

  it("when=attending applies the same live-event predicate as when=upcoming", async () => {
    repo.seedUser({ id: ALICE, displayName: "Alice", handle: "alice" })
    const inProgress = repo.seedCleanup({
      id: "aaaaaaaa-0000-0000-0000-000000000025",
      organizerUserId: ORG,
      title: "AttendingInProgress",
      scheduledAt: new Date("2026-05-31T18:00:00.000Z"),
      status: "active",
    })
    const finished = repo.seedCleanup({
      id: "aaaaaaaa-0000-0000-0000-000000000026",
      organizerUserId: ORG,
      title: "AttendingFinished",
      scheduledAt: new Date("2026-06-15T00:00:00.000Z"),
      status: "done",
    })
    repo.members.push({ cleanupId: inProgress.id, userId: ALICE, role: "member" })
    repo.members.push({ cleanupId: finished.id, userId: ALICE, role: "member" })

    const attending = await service.listCleanups({ when: "attending" }, { userId: ALICE })
    expect(attending.items.map((c) => c.title)).toEqual(["AttendingInProgress"])
  })

  it("keeps finished events in the past list (they are the civic history)", async () => {
    repo.seedCleanup({
      id: "aaaaaaaa-0000-0000-0000-000000000027",
      organizerUserId: ORG,
      title: "FinishedPast",
      scheduledAt: new Date("2026-05-10T00:00:00.000Z"),
      status: "done",
    })
    const past = await service.listCleanups({ when: "past" }, { userId: null })
    expect(past.items.map((c) => c.title)).toEqual(["FinishedPast"])
  })

  it("F070: a cancelled event whose date has passed stays out of the past list", async () => {
    repo.seedCleanup({
      id: "aaaaaaaa-0000-0000-0000-000000000011",
      organizerUserId: ORG,
      title: "RealPast",
      scheduledAt: new Date("2026-05-10T00:00:00.000Z"),
      status: "done",
    })
    repo.seedCleanup({
      id: "aaaaaaaa-0000-0000-0000-000000000012",
      organizerUserId: ORG,
      title: "CancelledPast",
      scheduledAt: new Date("2026-05-20T00:00:00.000Z"),
      status: "cancelled",
    })
    const past = await service.listCleanups({ when: "past" }, { userId: null })
    expect(past.items.map((c) => c.title)).toEqual(["RealPast"])
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

    const rsvped = await service.createCleanup(
      baseInput({ title: "RSVP", scheduledAt: new Date("2026-06-05T00:00:00.000Z").toISOString() }),
      BOB,
    )
    await service.joinCleanup(rsvped.id, ALICE)
    await service.createCleanup(
      baseInput({ title: "Hosted", scheduledAt: new Date("2026-06-08T00:00:00.000Z").toISOString() }),
      ALICE,
    )
    await service.createCleanup(
      baseInput({ title: "Other", scheduledAt: new Date("2026-06-03T00:00:00.000Z").toISOString() }),
      BOB,
    )

    const attending = await service.listCleanups({ when: "attending" }, { userId: ALICE })
    expect(attending.items.map((c) => c.title)).toEqual(["RSVP", "Hosted"])

    const anon = await service.listCleanups({ when: "attending" }, { userId: null })
    expect(anon.items).toEqual([])
  })

  it("pages with a cursor (limit 1) over future cleanups", async () => {
    for (let i = 1; i <= 3; i++) {
      repo.seedCleanup({
        id: `cccccccc-0000-0000-0000-00000000000${i}`,
        organizerUserId: ORG,
        title: `C${i}`,
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
    expect(res.items[0]!.dist!).toBeLessThan(res.items[1]!.dist!)
  })
})

describe("listAttendees (who's going)", () => {
  const CAROL = "44444444-4444-4444-4444-444444444444"
  const VIC = "55555555-5555-5555-5555-555555555555"

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
    repo.seedFollow(VIC, ALICE)
    repo.seedFollow(VIC, CAROL)

    const res = await service.listAttendees(created.id, { userId: VIC })
    expect(res.scope).toBe("following")
    expect(res.going).toBe(4)
    expect(res.attendees.map((p) => p.name)).toEqual(["Alice", "Carol"])
    expect(res.attendees.every((p) => p.isFollowing)).toBe(true)
  })

  it("carries each attendee's custom profile picture, and omits it when they have none", async () => {
    const created = await setupEvent()
    repo.seedUser({ id: ALICE, displayName: "Alice", avatarUrl: "https://cdn.test/alice.jpg" })

    const res = await service.listAttendees(created.id, { userId: ALICE })
    expect(res.attendees.find((p) => p.id === ALICE)?.avatarUrl).toBe("https://cdn.test/alice.jpg")
    expect(res.attendees.find((p) => p.id === BOB)).not.toHaveProperty("avatarUrl")
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

  it("host-role viewers (organizer + cohost) get the full roster past the 50 default cap; members stay capped", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    const memberIds: string[] = []
    for (let i = 0; i < 60; i++) {
      const id = `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`
      repo.seedUser({ id, displayName: `Member ${i}` })
      await service.joinCleanup(created.id, id)
      memberIds.push(id)
    }

    const asOrganizer = await service.listAttendees(created.id, { userId: ORG })
    expect(asOrganizer.attendees.length).toBe(61)
    expect(asOrganizer.attendees.length).toBeGreaterThan(ATTENDEES_DEFAULT_LIMIT)

    await service.setMemberRole(created.id, ORG, memberIds[0]!, "cohost")
    const asCohost = await service.listAttendees(created.id, { userId: memberIds[0]! })
    expect(asCohost.attendees.length).toBe(61)

    const asMember = await service.listAttendees(created.id, { userId: memberIds[1]! })
    expect(asMember.attendees.length).toBe(ATTENDEES_DEFAULT_LIMIT)
    expect(asMember.going).toBe(61)
  })

  it("marks isFollowing per attendee for a member viewer", async () => {
    const created = await setupEvent()
    repo.seedFollow(ALICE, BOB)
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

describe("requestResources (D19 event resource request)", () => {
  interface EventSend {
    cleanupId: string
    geoid: string | null
    toAddr: string
    subject: string
    text: string
  }

  function harness(opts: { contact?: { geoid: string; email: string } | null }) {
    const r = new InMemoryCleanupRepository()
    r.seedUser({ id: ORG, displayName: "Olive Organizer", handle: "olive" })
    const organization = r.seedOrganization({ name: "Ballona Creek Trust" })
    r.seedOrgMember(organization.id, ORG, "member")
    const sends: EventSend[] = []
    if (opts.contact) {
      r.jurisdictionContacts.set(opts.contact.geoid, {
        contact: opts.contact.email,
        name: "City of LA",
      })
    }
    const counters = new InMemoryCounterStore()
    const svc = makeCleanupService({
      repo: r,
      counters,
      outboundMail: {
        sendEventToJurisdiction: (input) => {
          sends.push({
            cleanupId: input.cleanupId,
            geoid: input.geoid,
            toAddr: input.toAddr,
            subject: input.subject,
            text: input.text,
          })
          return Promise.resolve({
            thread: {
              id: "thread-1",
              threadToken: "0".repeat(24),
              reportId: null,
              cleanupId: input.cleanupId,
              jurisdictionGeoid: input.geoid,
              org: null,
              subject: input.subject,
              status: "sent",
              unread: false,
              lastMessageAt: null,
              createdAt: new Date(),
            },
            messageId: "<out-1@civfix.org>",
          })
        },
        sendToCity: () => Promise.reject(new Error("unused")),
        prepareReportToJurisdiction: () => Promise.reject(new Error("unused")),
        sendReportToJurisdiction: () => Promise.reject(new Error("unused")),
        compose: () => Promise.reject(new Error("unused")),
        appendOutbound: () => Promise.reject(new Error("unused")),
      },
    })
    const creator = makeCleanupService({
      repo: r,
      counters: { incr: () => Promise.resolve(1), incrBy: () => Promise.resolve(1) },
    })
    return { repo: r, svc, sends, creator, organizationId: organization.id }
  }

  async function seedEvent(
    r: InMemoryCleanupRepository,
    creator: CleanupService,
    geoid: string | null,
    organizationId?: string,
  ): Promise<string> {
    const dto = await creator.createCleanup(
      baseInput({
        title: "Park Cleanup",
        ...(organizationId !== undefined ? { organizationId } : {}),
      }),
      ORG,
    )
    const stored = r.cleanups.get(dto.id)
    if (stored) stored.jurisdictionGeoid = geoid
    return dto.id
  }

  it("happy path: org-hosted event -> event thread send + resource_request timeline row", async () => {
    const { repo: r, svc, sends, creator, organizationId } = harness({
      contact: { geoid: "0644000", email: "events@lacity.gov" },
    })
    const id = await seedEvent(r, creator, "0644000", organizationId)
    const res = await svc.requestResources({ cleanupId: id, message: "Need 20 trash bags.", actorId: ORG })
    expect(res).toEqual({ ok: true })

    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ cleanupId: id, geoid: "0644000", toAddr: "events@lacity.gov" })
    expect(sends[0]!.subject).toContain("civfix event:")
    expect(sends[0]!.text).toContain("Need 20 trash bags.")

    const row = r.timeline.find((t) => t.cleanupId === id && t.kind === "resource_request")
    expect(row).toBeDefined()
    expect(row?.actorId).toBe(ORG)
    expect(row?.note).toContain("Need 20 trash bags.")
  })

  it("F068: 422s a slur in the message and neither sends nor writes a timeline row", async () => {
    const { repo: r, svc, sends, creator, organizationId } = harness({
      contact: { geoid: "0644000", email: "events@lacity.gov" },
    })
    const id = await seedEvent(r, creator, "0644000", organizationId)
    await expect(
      svc.requestResources({ cleanupId: id, message: "please send bags nigger", actorId: ORG }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(sends).toHaveLength(0)
    expect(r.timeline.find((t) => t.cleanupId === id && t.kind === "resource_request")).toBeUndefined()
  })


  it("M20: a FRESH event does not reset the host's budget (the old cleanupId-keyed bypass)", async () => {
    const { repo: r, svc, sends, creator, organizationId } = harness({
      contact: { geoid: "0644000", email: "events@lacity.gov" },
    })
    for (let i = 0; i < RESOURCE_REQUEST_PER_HOST_PER_DAY; i += 1) {
      const id = await seedEvent(r, creator, "0644000", organizationId)
      await svc.requestResources({ cleanupId: id, message: `Need bags ${i}.`, actorId: ORG })
    }
    expect(sends).toHaveLength(RESOURCE_REQUEST_PER_HOST_PER_DAY)

    const fresh = await seedEvent(r, creator, "0644000", organizationId)
    await expect(
      svc.requestResources({ cleanupId: fresh, message: "One more.", actorId: ORG }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
    expect(sends).toHaveLength(RESOURCE_REQUEST_PER_HOST_PER_DAY)
  })

  it("M20: caps a single jurisdiction per hour across DIFFERENT hosts (colluding accounts)", async () => {
    const { repo: r, svc, sends, organizationId } = harness({
      contact: { geoid: "0644000", email: "events@lacity.gov" },
    })
    let host = 0
    for (let i = 0; i < RESOURCE_REQUEST_PER_JURISDICTION_PER_HOUR; i += 1) {
      if (i % RESOURCE_REQUEST_PER_HOST_PER_DAY === 0) host += 1
      const organizer = `${host}${ORG.slice(1)}`
      r.seedUser({ id: organizer, displayName: `Host ${host}`, handle: `h${host}` })
      r.seedOrgMember(organizationId, organizer, "member")
      const dto = await svc.createCleanup(
        baseInput({ title: "Park Cleanup", organizationId }),
        organizer,
      )
      const stored = r.cleanups.get(dto.id)
      if (stored) stored.jurisdictionGeoid = "0644000"
      await svc.requestResources({ cleanupId: dto.id, message: "Need bags.", actorId: organizer })
    }
    expect(sends).toHaveLength(RESOURCE_REQUEST_PER_JURISDICTION_PER_HOUR)

    const nextHost = "9" + ORG.slice(1)
    r.seedUser({ id: nextHost, displayName: "Host 9", handle: "h9" })
    r.seedOrgMember(organizationId, nextHost, "member")
    const dto = await svc.createCleanup(
      baseInput({ title: "Park Cleanup", organizationId }),
      nextHost,
    )
    const stored = r.cleanups.get(dto.id)
    if (stored) stored.jurisdictionGeoid = "0644000"
    await expect(
      svc.requestResources({ cleanupId: dto.id, message: "Need bags.", actorId: nextHost }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
    expect(sends).toHaveLength(RESOURCE_REQUEST_PER_JURISDICTION_PER_HOUR)
  })

  it("M20: a rejected request (403) costs the host nothing", async () => {
    const { repo: r, svc, sends, creator, organizationId } = harness({
      contact: { geoid: "0644000", email: "events@lacity.gov" },
    })
    const id = await seedEvent(r, creator, "0644000", organizationId)
    await expect(
      svc.requestResources({ cleanupId: id, message: "hi", actorId: ALICE }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    for (let i = 0; i < RESOURCE_REQUEST_PER_HOST_PER_DAY; i += 1) {
      await svc.requestResources({ cleanupId: id, message: `Need bags ${i}.`, actorId: ORG })
    }
    expect(sends).toHaveLength(RESOURCE_REQUEST_PER_HOST_PER_DAY)
  })

  it("403s a non-host (and sends nothing)", async () => {
    const { repo: r, svc, sends, creator, organizationId } = harness({
      contact: { geoid: "0644000", email: "events@lacity.gov" },
    })
    const id = await seedEvent(r, creator, "0644000", organizationId)
    await expect(
      svc.requestResources({ cleanupId: id, message: "hi", actorId: ALICE }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(sends).toHaveLength(0)
  })

  it("403s a personal (org-less) event: city resources are an organization's ask", async () => {
    const { repo: r, svc, sends, creator } = harness({
      contact: { geoid: "0644000", email: "events@lacity.gov" },
    })
    const id = await seedEvent(r, creator, "0644000")
    await expect(
      svc.requestResources({ cleanupId: id, message: "hi", actorId: ORG }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(sends).toHaveLength(0)
  })

  it("403s an org member who only has a plain seat on the event (no manage_event)", async () => {
    const { repo: r, svc, sends, creator, organizationId } = harness({
      contact: { geoid: "0644000", email: "events@lacity.gov" },
    })
    const id = await seedEvent(r, creator, "0644000", organizationId)
    r.seedUser({ id: ALICE, displayName: "Alice", handle: "alice" })
    r.seedOrgMember(organizationId, ALICE, "member")
    await expect(
      svc.requestResources({ cleanupId: id, message: "hi", actorId: ALICE }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(sends).toHaveLength(0)
  })

  it("422 NOT_ROUTABLE when the jurisdiction has no contact on file", async () => {
    const { repo: r, svc, sends, creator, organizationId } = harness({ contact: null })
    const id = await seedEvent(r, creator, "0644000", organizationId)
    await expect(
      svc.requestResources({ cleanupId: id, message: "hi", actorId: ORG }),
    ).rejects.toMatchObject({ code: "NOT_ROUTABLE" })
    expect(sends).toHaveLength(0)
  })
})

describe("WS4 co-hosts: setMemberRole / removeMember / role-aware reads", () => {
  interface Bell {
    userId: string
    type: string
    titleKey?: string
    bodyKey?: string
    vars?: Record<string, string | number>
    link?: string
  }
  let bells: Bell[]
  let svc: CleanupService

  beforeEach(() => {
    bells = []
    svc = makeCleanupService({
      repo,
      counters: new InMemoryCounterStore(),
      notifier: {
        createNotification: (userId, input) => {
          bells.push({
            userId,
            type: input.type,
            ...(input.titleKey !== undefined ? { titleKey: input.titleKey } : {}),
            ...(input.bodyKey !== undefined ? { bodyKey: input.bodyKey } : {}),
            ...(input.vars !== undefined ? { vars: input.vars } : {}),
            ...(input.link !== undefined ? { link: input.link } : {}),
          })
          return Promise.resolve({
            id: "n1",
            type: input.type,
            title: "",
            read: false,
            createdAt: new Date().toISOString(),
          })
        },
      },
    })
  })

  async function setup(): Promise<string> {
    repo.seedUser({ id: ALICE, displayName: "Alice" })
    repo.seedUser({ id: BOB, displayName: "Bob" })
    const created = await svc.createCleanup(baseInput({ title: "Creek sweep" }), ORG)
    await svc.joinCleanup(created.id, ALICE)
    await svc.joinCleanup(created.id, BOB)
    return created.id
  }

  it("the organizer promotes a member to cohost (role flips + cleanup_role bell)", async () => {
    const id = await setup()
    const res = await svc.setMemberRole(id, ORG, ALICE, "cohost")
    expect(res).toEqual({ ok: true })
    expect(await repo.roleOf(id, ALICE)).toBe("cohost")

    expect(bells).toEqual([
      {
        userId: ALICE,
        type: "cleanup_role",
        titleKey: "notification.cleanup_role.promoted.title",
        bodyKey: "notification.cleanup_role.promoted.body",
        vars: { title: "Creek sweep" },
        link: `/cleanups/${id}`,
      },
    ])
  })

  it("the organizer demotes a cohost back to member (bell: demoted)", async () => {
    const id = await setup()
    await svc.setMemberRole(id, ORG, ALICE, "cohost")
    bells.length = 0

    await svc.setMemberRole(id, ORG, ALICE, "member")
    expect(await repo.roleOf(id, ALICE)).toBe("member")
    expect(bells.map((b) => b.bodyKey)).toEqual(["notification.cleanup_role.demoted.body"])
  })

  it("setting the role a member already has is an idempotent no-op (no bell)", async () => {
    const id = await setup()
    const res = await svc.setMemberRole(id, ORG, ALICE, "member")
    expect(res).toEqual({ ok: true })
    expect(bells).toHaveLength(0)
  })

  it("assigns the day-of STAFF role, which the contract accepts alongside cohost and member", async () => {
    const id = await setup()
    const res = await svc.setMemberRole(id, ORG, ALICE, "staff")
    expect(res).toEqual({ ok: true })
    expect(await repo.roleOf(id, ALICE)).toBe("staff")
    expect(bells.map((b) => b.bodyKey)).toEqual(["notification.cleanup_role.promoted.body"])
  })

  it("moves someone between staff and cohost, and back down to member", async () => {
    const id = await setup()
    await svc.setMemberRole(id, ORG, ALICE, "staff")
    await svc.setMemberRole(id, ORG, ALICE, "cohost")
    expect(await repo.roleOf(id, ALICE)).toBe("cohost")
    await svc.setMemberRole(id, ORG, ALICE, "member")
    expect(await repo.roleOf(id, ALICE)).toBe("member")
  })

  it("never lets the organizer's own role be changed, staff included", async () => {
    const id = await setup()
    await expect(svc.setMemberRole(id, ORG, ORG, "staff")).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  it("403s a cohost or plain member trying to promote/demote (organizer-only, D3)", async () => {
    const id = await setup()
    await svc.setMemberRole(id, ORG, ALICE, "cohost")
    await expect(svc.setMemberRole(id, ALICE, BOB, "cohost")).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(svc.setMemberRole(id, BOB, ALICE, "member")).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    expect(await repo.roleOf(id, BOB)).toBe("member")
  })

  it("the organizer's own role is immutable (403 self-target)", async () => {
    const id = await setup()
    await expect(svc.setMemberRole(id, ORG, ORG, "cohost")).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    expect(await repo.roleOf(id, ORG)).toBe("organizer")
  })

  it("404s a target who is not attending, and a missing cleanup", async () => {
    const id = await setup()
    await expect(
      svc.setMemberRole(id, ORG, "99999999-9999-9999-9999-999999999999", "cohost"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      svc.setMemberRole("00000000-0000-0000-0000-000000000000", ORG, ALICE, "cohost"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("the organizer removes a plain member (row gone -> chat access gone; bell: removed)", async () => {
    const id = await setup()
    const res = await svc.removeMember(id, ORG, BOB)
    expect(res).toEqual({ ok: true, going: 2 })
    expect(await repo.isMember(id, BOB)).toBe(false)
    expect(bells).toEqual([
      {
        userId: BOB,
        type: "cleanup_role",
        titleKey: "notification.cleanup_role.removed.title",
        bodyKey: "notification.cleanup_role.removed.body",
        vars: { title: "Creek sweep" },
        link: `/cleanups/${id}`,
      },
    ])
  })

  it("the organizer can remove a cohost; a cohost can remove a plain member", async () => {
    const id = await setup()
    await svc.setMemberRole(id, ORG, ALICE, "cohost")

    const byCohost = await svc.removeMember(id, ALICE, BOB)
    expect(byCohost).toEqual({ ok: true, going: 2 })
    expect(await repo.isMember(id, BOB)).toBe(false)

    const byOrg = await svc.removeMember(id, ORG, ALICE)
    expect(byOrg).toEqual({ ok: true, going: 1 })
    expect(await repo.isMember(id, ALICE)).toBe(false)
  })

  it("403s a cohost removing another cohost (organizer-only), and a plain-member actor", async () => {
    const id = await setup()
    await svc.setMemberRole(id, ORG, ALICE, "cohost")
    const CAROL = "44444444-4444-4444-4444-444444444444"
    await svc.joinCleanup(id, CAROL)
    await svc.setMemberRole(id, ORG, CAROL, "cohost")

    await expect(svc.removeMember(id, ALICE, CAROL)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(svc.removeMember(id, BOB, ALICE)).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(await repo.isMember(id, CAROL)).toBe(true)
  })

  it("nobody removes the organizer; self-removal is a 409 (use leave)", async () => {
    const id = await setup()
    await svc.setMemberRole(id, ORG, ALICE, "cohost")
    await expect(svc.removeMember(id, ALICE, ORG)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(svc.removeMember(id, ORG, ORG)).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(svc.removeMember(id, ALICE, ALICE)).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await repo.isMember(id, ORG)).toBe(true)
  })

  it("404s removing someone who is not attending", async () => {
    const id = await setup()
    await expect(
      svc.removeMember(id, ORG, "99999999-9999-9999-9999-999999999999"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("a cohost CAN edit the event; a plain member cannot (D3)", async () => {
    const id = await setup()
    await svc.setMemberRole(id, ORG, ALICE, "cohost")

    const updated = await svc.updateCleanup(id, { title: "New title" }, ALICE)
    expect(updated.title).toBe("New title")
    expect(updated.myRole).toBe("cohost")

    await expect(svc.updateCleanup(id, { title: "Nope" }, BOB)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  it("a cohost CANNOT cancel (organizer-only, D3) but CAN leave", async () => {
    const id = await setup()
    await svc.setMemberRole(id, ORG, ALICE, "cohost")
    await expect(svc.cancelCleanup(id, null, ALICE)).rejects.toMatchObject({ code: "FORBIDDEN" })

    const left = await svc.leaveCleanup(id, ALICE)
    expect(left).toEqual({ joined: false, going: 2 })
    expect(await repo.isMember(id, ALICE)).toBe(false)
  })

  it("surfaces myRole on getCleanup + listCleanups and role on the attendees roster", async () => {
    const id = await setup()
    await svc.setMemberRole(id, ORG, ALICE, "cohost")

    expect((await svc.getCleanup(id, { userId: ORG })).myRole).toBe("organizer")
    expect((await svc.getCleanup(id, { userId: ALICE })).myRole).toBe("cohost")
    expect((await svc.getCleanup(id, { userId: BOB })).myRole).toBe("member")
    const STRANGER = "99999999-9999-9999-9999-999999999999"
    expect((await svc.getCleanup(id, { userId: STRANGER })).myRole).toBeUndefined()
    expect((await svc.getCleanup(id, { userId: null })).myRole).toBeUndefined()

    const listed = await svc.listCleanups({ when: "upcoming" }, { userId: ALICE })
    expect(listed.items.find((c) => c.id === id)?.myRole).toBe("cohost")

    const roster = await svc.listAttendees(id, { userId: ALICE })
    const rolesByName = Object.fromEntries(roster.attendees.map((p) => [p.name, p.role]))
    expect(rolesByName).toEqual({ "Olive Organizer": "organizer", Alice: "cohost", Bob: "member" })
    expect(roster.attendees.map((p) => p.name)).toEqual(["Olive Organizer", "Alice", "Bob"])
  })
})


describe("M17: attendee removal is enforceable (cleanup_bans)", () => {
  let svc: CleanupService

  beforeEach(() => {
    repo.seedUser({ id: ALICE, displayName: "Alice" })
    repo.seedUser({ id: BOB, displayName: "Bob" })
    svc = makeCleanupService({ repo, counters: new InMemoryCounterStore() })
  })

  it("a removed attendee CANNOT re-join themselves (the removal used to be purely cosmetic)", async () => {
    const created = await svc.createCleanup(baseInput(), ORG)
    await svc.joinCleanup(created.id, BOB)
    expect(await repo.isMember(created.id, BOB)).toBe(true)

    await svc.removeMember(created.id, ORG, BOB)
    expect(await repo.isMember(created.id, BOB)).toBe(false)

    await expect(svc.joinCleanup(created.id, BOB)).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(await repo.isMember(created.id, BOB)).toBe(false)
  })

  it("the ban is recorded against the removing host and is scoped to that one event", async () => {
    const a = await svc.createCleanup(baseInput({ title: "Event A" }), ORG)
    const b = await svc.createCleanup(baseInput({ title: "Event B" }), ORG)
    await svc.joinCleanup(a.id, BOB)

    await svc.removeMember(a.id, ORG, BOB)
    expect(repo.bans).toContainEqual({ cleanupId: a.id, userId: BOB, bannedByUserId: ORG })

    const joined = await svc.joinCleanup(b.id, BOB)
    expect(joined.joined).toBe(true)
  })

  it("leaving voluntarily does NOT ban you — you can RSVP again", async () => {
    const created = await svc.createCleanup(baseInput(), ORG)
    await svc.joinCleanup(created.id, BOB)
    await svc.leaveCleanup(created.id, BOB)
    expect(repo.bans).toHaveLength(0)

    const rejoined = await svc.joinCleanup(created.id, BOB)
    expect(rejoined.joined).toBe(true)
  })

  it("the organizer lifts a ban by re-asserting the 'member' role on the removed person", async () => {
    const created = await svc.createCleanup(baseInput(), ORG)
    await svc.joinCleanup(created.id, BOB)
    await svc.removeMember(created.id, ORG, BOB)

    const res = await svc.setMemberRole(created.id, ORG, BOB, "member")
    expect(res).toEqual({ ok: true })
    expect(repo.bans).toHaveLength(0)
    expect(await repo.isMember(created.id, BOB)).toBe(false)
    const rejoined = await svc.joinCleanup(created.id, BOB)
    expect(rejoined.joined).toBe(true)
  })

  it("the unban path is organizer-only and does not promote a banned person to cohost", async () => {
    const created = await svc.createCleanup(baseInput(), ORG)
    await svc.joinCleanup(created.id, ALICE)
    await svc.joinCleanup(created.id, BOB)
    await svc.setMemberRole(created.id, ORG, ALICE, "cohost")
    await svc.removeMember(created.id, ORG, BOB)

    await expect(svc.setMemberRole(created.id, ALICE, BOB, "member")).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(svc.setMemberRole(created.id, ORG, BOB, "cohost")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    expect(repo.bans).toHaveLength(1)
  })
})

describe("M18: promote/demote notification bombing", () => {
  it("caps role flips per (event, target) once the two-value idempotency check is defeated", async () => {
    repo.seedUser({ id: ALICE, displayName: "Alice" })
    const svc = makeCleanupService({ repo, counters: new InMemoryCounterStore() })
    const created = await svc.createCleanup(baseInput(), ORG)
    await svc.joinCleanup(created.id, ALICE)

    let flips = 0
    let err: unknown = null
    for (let i = 0; i < ROLE_CHANGES_PER_TARGET_PER_WINDOW + 5; i += 1) {
      try {
        await svc.setMemberRole(created.id, ORG, ALICE, i % 2 === 0 ? "cohost" : "member")
        flips += 1
      } catch (e) {
        err = e
        break
      }
    }
    expect(flips).toBe(ROLE_CHANGES_PER_TARGET_PER_WINDOW)
    expect(err).toMatchObject({ code: "RATE_LIMITED" })
  })

  it("the cap is per TARGET — throttling one attendee does not lock out the roster", async () => {
    repo.seedUser({ id: ALICE, displayName: "Alice" })
    repo.seedUser({ id: BOB, displayName: "Bob" })
    const svc = makeCleanupService({ repo, counters: new InMemoryCounterStore() })
    const created = await svc.createCleanup(baseInput(), ORG)
    await svc.joinCleanup(created.id, ALICE)
    await svc.joinCleanup(created.id, BOB)

    for (let i = 0; i < ROLE_CHANGES_PER_TARGET_PER_WINDOW; i += 1) {
      await svc.setMemberRole(created.id, ORG, ALICE, i % 2 === 0 ? "cohost" : "member")
    }
    await expect(svc.setMemberRole(created.id, ORG, ALICE, "cohost")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
    await expect(svc.setMemberRole(created.id, ORG, BOB, "cohost")).resolves.toEqual({ ok: true })
  })
})

describe("M19: the slur filter reaches event fields", () => {
  const SLUR = "nigger"

  it("rejects a slur in the event title, description, address and bring list on create", async () => {
    for (const over of [
      { title: `Cleanup ${SLUR}` },
      { description: `bring gloves ${SLUR}` },
      { address: `north gate ${SLUR}` },
      { bring: ["gloves", `bags ${SLUR}`] },
    ]) {
      await expect(service.createCleanup(baseInput(over), ORG)).rejects.toMatchObject({
        code: "VALIDATION",
      })
    }
    expect(repo.cleanups.size).toBe(0)
  })

  it("rejects a slur on update", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    await expect(
      service.updateCleanup(created.id, { title: `Cleanup ${SLUR}` }, ORG),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(repo.cleanups.get(created.id)?.title).toBe("Beach cleanup")
  })

  it("rejects a slur in the cancellation reason (which fans out to every attendee)", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    await expect(
      service.cancelCleanup(created.id, `called off, ${SLUR}`, ORG),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(repo.cleanups.get(created.id)?.status).toBe("upcoming")
  })

  it("still accepts ordinary event text", async () => {
    const dto = await service.createCleanup(
      baseInput({ title: "Ballona Creek sweep", description: "Meet by the bridge", address: "North gate", bring: ["gloves"] }),
      ORG,
    )
    expect(dto.title).toBe("Ballona Creek sweep")
  })
})

describe("L23: the unbounded `bring` array is clamped", () => {
  it("422s more than MAX_BRING_ITEMS entries on create and on update", async () => {
    const tooMany = Array.from({ length: MAX_BRING_ITEMS + 1 }, (_, i) => `item ${i}`)
    await expect(service.createCleanup(baseInput({ bring: tooMany }), ORG)).rejects.toMatchObject({
      code: "VALIDATION",
    })

    const created = await service.createCleanup(baseInput({ bring: ["gloves"] }), ORG)
    await expect(service.updateCleanup(created.id, { bring: tooMany }, ORG)).rejects.toMatchObject({
      code: "VALIDATION",
    })
    expect(repo.cleanups.get(created.id)?.bring).toEqual(["gloves"])
  })

  it("accepts exactly MAX_BRING_ITEMS", async () => {
    const atCap = Array.from({ length: MAX_BRING_ITEMS }, (_, i) => `item ${i}`)
    const dto = await service.createCleanup(baseInput({ bring: atCap }), ORG)
    expect(dto.bring).toHaveLength(MAX_BRING_ITEMS)
  })
})

describe("L24: the cancellation fan-out rides the notification pipeline", () => {
  it("emits one cleanup_cancelled notification per OTHER member, through the service (not raw SQL)", async () => {
    repo.seedUser({ id: ALICE, displayName: "Alice" })
    repo.seedUser({ id: BOB, displayName: "Bob" })
    const bells: {
      userId: string
      type: string
      titleKey?: string
      bodyKey?: string
      vars?: Record<string, string | number>
      link?: string
    }[] = []
    const svc = makeCleanupService({
      repo,
      counters: new InMemoryCounterStore(),
      notifier: {
        createNotification: (userId, input) => {
          bells.push({
            userId,
            type: input.type,
            ...(input.titleKey !== undefined ? { titleKey: input.titleKey } : {}),
            ...(input.bodyKey !== undefined ? { bodyKey: input.bodyKey } : {}),
            ...(input.vars !== undefined ? { vars: input.vars } : {}),
            ...(input.link !== undefined ? { link: input.link } : {}),
          })
          return Promise.resolve({
            id: "n1",
            type: input.type,
            title: "",
            read: false,
            createdAt: new Date().toISOString(),
          })
        },
      },
    })

    const created = await svc.createCleanup(baseInput(), ORG)
    await svc.joinCleanup(created.id, ALICE)
    await svc.joinCleanup(created.id, BOB)

    await svc.cancelCleanup(created.id, "Storm warning", ORG)

    expect(bells.map((b) => b.userId).sort()).toEqual([ALICE, BOB].sort())
    expect(bells.every((b) => b.type === "cleanup_cancelled")).toBe(true)
    expect(
      bells.every(
        (b) =>
          b.titleKey === "notification.cleanup_cancelled.title" &&
          b.bodyKey === "notification.cleanup_cancelled.body_reason",
      ),
    ).toBe(true)
    expect(bells.every((b) => b.vars?.reason === "Storm warning")).toBe(true)
    expect(bells.every((b) => b.link === `/cleanups/${created.id}`)).toBe(true)
    expect(bells.some((b) => b.userId === ORG)).toBe(false)
  })

  it("a cancellation with NO reason selects the reason-less body key and sends no vars", async () => {
    repo.seedUser({ id: ALICE, displayName: "Alice" })
    const bells: { bodyKey?: string; vars?: Record<string, string | number> }[] = []
    const svc = makeCleanupService({
      repo,
      counters: new InMemoryCounterStore(),
      notifier: {
        createNotification: (_userId, input) => {
          bells.push({
            ...(input.bodyKey !== undefined ? { bodyKey: input.bodyKey } : {}),
            ...(input.vars !== undefined ? { vars: input.vars } : {}),
          })
          return Promise.resolve({
            id: "n1",
            type: input.type,
            title: "",
            read: false,
            createdAt: new Date().toISOString(),
          })
        },
      },
    })
    const created = await svc.createCleanup(baseInput(), ORG)
    await svc.joinCleanup(created.id, ALICE)

    await svc.cancelCleanup(created.id, "   ", ORG)

    expect(bells).toEqual([{ bodyKey: "notification.cleanup_cancelled.body" }])
  })

  it("only a FRESH transition rings the roster: re-cancelling pushes no second bell", async () => {
    repo.seedUser({ id: ALICE, displayName: "Alice" })
    const bells: string[] = []
    const svc = makeCleanupService({
      repo,
      counters: new InMemoryCounterStore(),
      notifier: {
        createNotification: (userId, input) => {
          bells.push(userId)
          return Promise.resolve({
            id: "n1",
            type: input.type,
            title: "",
            read: false,
            createdAt: new Date().toISOString(),
          })
        },
      },
    })
    const created = await svc.createCleanup(baseInput(), ORG)
    await svc.joinCleanup(created.id, ALICE)

    await svc.cancelCleanup(created.id, "Storm warning", ORG)
    expect(bells).toEqual([ALICE])

    const second = await svc.cancelCleanup(created.id, "Storm warning", ORG)
    expect(second.status).toBe("cancelled")
    expect(bells).toEqual([ALICE])
    expect(
      repo.timeline.filter((t) => t.cleanupId === created.id && t.kind === "cancel"),
    ).toHaveLength(1)
  })

  it("one recipient's failure does not abandon the rest of the roster (per-recipient isolation)", async () => {
    const CAROL = "44444444-4444-4444-4444-444444444444"
    repo.seedUser({ id: ALICE, displayName: "Alice" })
    repo.seedUser({ id: BOB, displayName: "Bob" })
    repo.seedUser({ id: CAROL, displayName: "Carol" })
    const delivered: string[] = []
    const warned: { userId?: string; cleanupId?: string }[] = []
    const svc = makeCleanupService({
      repo,
      counters: new InMemoryCounterStore(),
      logger: {
        warn: (obj) => {
          warned.push(obj as { userId?: string; cleanupId?: string })
        },
        error: () => {},
      },
      notifier: {
        createNotification: async (userId, input) => {
          await Promise.resolve()
          if (userId === ALICE) throw new Error("prefs row corrupt")
          delivered.push(userId)
          return {
            id: "n1",
            type: input.type,
            title: "",
            read: false,
            createdAt: new Date().toISOString(),
          }
        },
      },
    })
    const created = await svc.createCleanup(baseInput(), ORG)
    await svc.joinCleanup(created.id, ALICE)
    await svc.joinCleanup(created.id, BOB)
    await svc.joinCleanup(created.id, CAROL)

    const dto = await svc.cancelCleanup(created.id, null, ORG)

    expect(dto.status).toBe("cancelled")
    expect(delivered.sort()).toEqual([BOB, CAROL].sort())
    expect(warned).toHaveLength(1)
    expect(warned[0]!.userId).toBe(ALICE)
    expect(warned[0]!.cleanupId).toBe(created.id)
  })

  it("a notifier failure never fails the cancellation itself (best-effort, like every other bell)", async () => {
    repo.seedUser({ id: ALICE, displayName: "Alice" })
    const svc = makeCleanupService({
      repo,
      counters: new InMemoryCounterStore(),
      notifier: { createNotification: () => Promise.reject(new Error("push down")) },
    })
    const created = await svc.createCleanup(baseInput(), ORG)
    await svc.joinCleanup(created.id, ALICE)

    const dto = await svc.cancelCleanup(created.id, null, ORG)
    expect(dto.status).toBe("cancelled")
  })
})

describe("cleanup state machine (terminal states)", () => {
  beforeEach(() => {
    repo.seedUser({ id: ALICE, displayName: "Alice" })
  })

  it("409s editing a cancelled event", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    await service.cancelCleanup(created.id, null, ORG)
    await expect(service.updateCleanup(created.id, { title: "Nope" }, ORG)).rejects.toMatchObject({
      code: "CONFLICT",
    })
  })

  it("F067: freezes the title of a completed event but still allows a cosmetic description edit", async () => {
    const created = await service.createCleanup(baseInput({ scheduledAt: PAST }), ORG)
    await service.completeCleanup(created.id, null, ORG)
    await expect(
      service.updateCleanup(created.id, { title: "Renamed" }, ORG),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    const edited = await service.updateCleanup(created.id, { description: "post-event recap" }, ORG)
    expect(edited.description).toBe("post-event recap")
  })

  it("409s joining a cancelled event", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    await service.cancelCleanup(created.id, null, ORG)
    await expect(service.joinCleanup(created.id, ALICE)).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("409s joining a completed event", async () => {
    const created = await service.createCleanup(baseInput({ scheduledAt: PAST }), ORG)
    await service.completeCleanup(created.id, null, ORG)
    await expect(service.joinCleanup(created.id, ALICE)).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("still allows editing and joining an upcoming event", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    const edited = await service.updateCleanup(created.id, { title: "Renamed" }, ORG)
    expect(edited.title).toBe("Renamed")
    const joined = await service.joinCleanup(created.id, ALICE)
    expect(joined).toEqual({ joined: true, going: 2 })
  })
})

describe("CVX-006: PATCH cannot backdate an event past the create-time floor", () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

  it("422s moving a live event 30 days into the past", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    const original = repo.cleanups.get(created.id)?.scheduledAt

    await expect(
      service.updateCleanup(created.id, { scheduledAt: daysAgo(30) }, ORG),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(repo.cleanups.get(created.id)?.scheduledAt).toEqual(original)
  })

  it("F067: refuses any scheduledAt/title change on a completed event, even echoing the stored date", async () => {
    const created = await service.createCleanup(baseInput({ scheduledAt: daysAgo(30) }), ORG)
    await service.completeCleanup(created.id, null, ORG)
    const stored = repo.cleanups.get(created.id)!.scheduledAt.toISOString()

    await expect(
      service.updateCleanup(
        created.id,
        { scheduledAt: stored, title: "Renamed after the fact" },
        ORG,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(repo.cleanups.get(created.id)!.title).toBe("Beach cleanup")
  })

  it("allows moving a backdated event FORWARD but not further into the past", async () => {
    const created = await service.createCleanup(baseInput({ scheduledAt: daysAgo(30) }), ORG)

    const laterButStillPast = daysAgo(29)
    const edited = await service.updateCleanup(
      created.id,
      { scheduledAt: laterButStillPast },
      ORG,
    )
    expect(edited.scheduledAt).toBe(laterButStillPast)

    await expect(
      service.updateCleanup(created.id, { scheduledAt: daysAgo(40) }, ORG),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("accepts a scheduledAt inside the one-day backdate window", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    const justNow = new Date(Date.now() - 60_000).toISOString()

    const edited = await service.updateCleanup(created.id, { scheduledAt: justNow }, ORG)
    expect(edited.scheduledAt).toBe(justNow)
  })
})

describe("F157: cancellation fan-out leaves the request path", () => {
  function bellHarness(jobs?: FakeJobs) {
    const bells: string[] = []
    const svc = makeCleanupService({
      repo,
      counters: new InMemoryCounterStore(),
      ...(jobs !== undefined ? { jobs } : {}),
      notifier: {
        createNotification: (userId, input) => {
          bells.push(userId)
          return Promise.resolve({
            id: "n1",
            type: input.type,
            title: "",
            read: false,
            createdAt: new Date().toISOString(),
          })
        },
      },
    })
    return { svc, bells }
  }

  it("enqueues cleanup.cancel.fanout instead of ringing 2000 members inline", async () => {
    repo.seedUser({ id: ALICE, displayName: "Alice" })
    repo.seedUser({ id: BOB, displayName: "Bob" })
    const jobs = new FakeJobs()
    const { svc, bells } = bellHarness(jobs)
    const created = await svc.createCleanup(baseInput(), ORG)
    await svc.joinCleanup(created.id, ALICE)
    await svc.joinCleanup(created.id, BOB)

    await svc.cancelCleanup(created.id, "Storm warning", ORG)

    expect(bells).toEqual([])
    const enqueued = jobs.jobsFor(CLEANUP_CANCEL_FANOUT_JOB)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]?.data).toEqual({
      cleanupId: created.id,
      reason: "Storm warning",
      actorId: ORG,
    })
    expect(enqueued[0]?.opts?.singletonKey).toBe(created.id)
  })

  function dedupingBellHarness(jobs: FakeJobs) {
    const bells: string[] = []
    const seen = new Set<string>()
    const svc = makeCleanupService({
      repo,
      counters: new InMemoryCounterStore(),
      jobs,
      notifier: {
        createNotification: (userId, input) => {
          const record = {
            id: "n1",
            type: input.type,
            title: "",
            read: false,
            createdAt: new Date().toISOString(),
          }
          const key = `${userId}|${input.type}|${input.link ?? ""}`
          if (input.dedupeWindowMs !== undefined && seen.has(key)) return Promise.resolve(record)
          seen.add(key)
          bells.push(userId)
          return Promise.resolve(record)
        },
      },
    })
    return { svc, bells }
  }

  it("a redelivered cancel fan-out does not re-bell the members it already rang", async () => {
    repo.seedUser({ id: ALICE, displayName: "Alice" })
    repo.seedUser({ id: BOB, displayName: "Bob" })
    const jobs = new FakeJobs()
    const { svc, bells } = dedupingBellHarness(jobs)
    const created = await svc.createCleanup(baseInput(), ORG)
    await svc.joinCleanup(created.id, ALICE)
    await svc.joinCleanup(created.id, BOB)
    await svc.cancelCleanup(created.id, "Storm warning", ORG)
    expect(bells).toEqual([])

    const job = { cleanupId: created.id, reason: "Storm warning", actorId: ORG }
    await svc.runCancelFanout(job)
    expect(bells.sort()).toEqual([ALICE, BOB].sort())

    await svc.runCancelFanout(job)
    expect(bells.sort()).toEqual([ALICE, BOB].sort())
  })

  it("never fans out to guests from the request path when the enqueue fails", async () => {
    const jobs = new FakeJobs()
    jobs.enqueue = () => Promise.reject(new Error("pg-boss unavailable"))
    const guestCalls: string[] = []
    const errors: unknown[] = []
    const svc = makeCleanupService({
      repo,
      counters: new InMemoryCounterStore(),
      jobs,
      logger: { warn: () => {}, error: (obj) => errors.push(obj) },
      attendeeNotifier: {
        eventCancelled: (cleanupId: string) => {
          guestCalls.push(cleanupId)
          return Promise.resolve(null)
        },
      },
    })
    const created = await svc.createCleanup(baseInput(), ORG)

    await expect(svc.cancelCleanup(created.id, "Storm warning", ORG)).resolves.toMatchObject({
      status: "cancelled",
    })
    expect(repo.cleanups.get(created.id)?.status).toBe("cancelled")
    expect(guestCalls).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it("enqueues cleanup.guest.update.fanout when a guest-visible detail changes", async () => {
    const jobs = new FakeJobs()
    const { svc } = bellHarness(jobs)
    const created = await svc.createCleanup(baseInput(), ORG)

    await svc.updateCleanup(created.id, { address: "500 New Pier Rd" }, ORG)

    const enqueued = jobs.jobsFor(CLEANUP_GUEST_UPDATE_FANOUT_JOB)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]?.data).toEqual({ cleanupId: created.id })
    expect(enqueued[0]?.opts?.singletonKey).toBe(created.id)
  })

  it("does not enqueue a guest fanout for an edit no guest can see", async () => {
    const jobs = new FakeJobs()
    const { svc } = bellHarness(jobs)
    const created = await svc.createCleanup(baseInput(), ORG)

    await svc.updateCleanup(created.id, { title: "Beach sweep (renamed)" }, ORG)

    expect(jobs.jobsFor(CLEANUP_GUEST_UPDATE_FANOUT_JOB)).toHaveLength(0)
  })

  it("does not fan out to guests inline when no job queue is wired at all", async () => {
    const guestCalls: string[] = []
    const svc = makeCleanupService({
      repo,
      counters: new InMemoryCounterStore(),
      attendeeNotifier: {
        eventCancelled: (cleanupId: string) => {
          guestCalls.push(cleanupId)
          return Promise.resolve(null)
        },
      },
    })
    const created = await svc.createCleanup(baseInput(), ORG)

    await svc.updateCleanup(created.id, { address: "500 New Pier Rd" }, ORG)
    await svc.cancelCleanup(created.id, null, ORG)

    expect(guestCalls).toEqual([])
  })

  it("lets a guest-fanout failure escape the JOB path so pg-boss can redeliver", async () => {
    const svc = makeCleanupService({
      repo,
      counters: new InMemoryCounterStore(),
      attendeeNotifier: {
        eventCancelled: () => Promise.reject(new Error("guest roster read failed")),
      },
    })
    const created = await svc.createCleanup(baseInput(), ORG)

    await expect(
      svc.runCancelFanout({ cleanupId: created.id, reason: null, actorId: ORG }),
    ).rejects.toThrow("guest roster read failed")
  })

  it("the enqueued job delivers exactly the bells the inline path used to", async () => {
    repo.seedUser({ id: ALICE, displayName: "Alice" })
    repo.seedUser({ id: BOB, displayName: "Bob" })
    const jobs = new FakeJobs()
    const { svc, bells } = bellHarness(jobs)
    const created = await svc.createCleanup(baseInput(), ORG)
    await svc.joinCleanup(created.id, ALICE)
    await svc.joinCleanup(created.id, BOB)
    await svc.cancelCleanup(created.id, "Storm warning", ORG)

    await svc.runCancelFanout({ cleanupId: created.id, reason: "Storm warning", actorId: ORG })

    expect(bells.sort()).toEqual([ALICE, BOB].sort())
  })

  it("falls back to the inline MEMBER fan-out when the queue refuses the job", async () => {
    repo.seedUser({ id: ALICE, displayName: "Alice" })
    const failing = new FakeJobs()
    failing.enqueue = () => Promise.reject(new Error("queue down"))
    const { svc, bells } = bellHarness(failing)
    const created = await svc.createCleanup(baseInput(), ORG)
    await svc.joinCleanup(created.id, ALICE)

    await svc.cancelCleanup(created.id, "Storm warning", ORG)

    expect(bells).toEqual([ALICE])
  })
})

describe("insights invalidation", () => {
  function invalidatingService(): { svc: CleanupService; bumped: string[] } {
    const bumped: string[] = []
    const svc = makeCleanupService({
      repo,
      counters: new InMemoryCounterStore(),
      insightsInvalidator: {
        bumpInsightsGeneration: (cleanupId) => {
          bumped.push(cleanupId)
          return Promise.resolve()
        },
      },
    })
    return { svc, bumped }
  }

  it("bumps the insights generation when the host cancels the event", async () => {
    const { svc, bumped } = invalidatingService()
    const created = await svc.createCleanup(baseInput(), ORG)

    await svc.cancelCleanup(created.id, null, ORG)

    expect(bumped).toEqual([created.id])
  })

  it("bumps the insights generation when the host completes the event", async () => {
    const { svc, bumped } = invalidatingService()
    const created = await svc.createCleanup(baseInput({ scheduledAt: PAST }), ORG)

    await svc.completeCleanup(created.id, null, ORG)

    expect(bumped).toEqual([created.id])
  })

  it("leaves the generation alone when the status flip is refused", async () => {
    const { svc, bumped } = invalidatingService()
    const created = await svc.createCleanup(baseInput(), ORG)

    await expect(svc.cancelCleanup(created.id, null, ALICE)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(svc.completeCleanup(created.id, null, ORG)).rejects.toMatchObject({
      code: "CONFLICT",
    })

    expect(bumped).toEqual([])
  })
})
