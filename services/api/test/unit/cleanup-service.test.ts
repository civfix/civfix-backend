import { describe, it, expect, beforeEach } from "vitest"
import {
  makeCleanupService,
  ATTENDEES_DEFAULT_LIMIT,
  type CleanupService,
} from "../../src/services/cleanup-service.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import type { CreateCleanupRequest } from "@civfix/shared"


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

    // Organizer sees everyone (61 = organizer + 60 members).
    const asOrganizer = await service.listAttendees(created.id, { userId: ORG })
    expect(asOrganizer.attendees.length).toBe(61)
    expect(asOrganizer.attendees.length).toBeGreaterThan(ATTENDEES_DEFAULT_LIMIT)

    // A promoted cohost gets the same host-scoped roster.
    await service.setMemberRole(created.id, ORG, memberIds[0]!, "cohost")
    const asCohost = await service.listAttendees(created.id, { userId: memberIds[0]! })
    expect(asCohost.attendees.length).toBe(61)

    // A plain member stays on the default cap (going count is still the real total).
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

  function harness(opts: { verified: boolean; contact?: { geoid: string; email: string } | null }) {
    const r = new InMemoryCleanupRepository()
    r.seedUser({ id: ORG, displayName: "Olive Organizer", handle: "olive" })
    const sends: EventSend[] = []
    if (opts.contact) {
      r.jurisdictionContacts.set(opts.contact.geoid, {
        contact: opts.contact.email,
        name: "City of LA",
      })
    }
    const svc = makeCleanupService({
      repo: r,
      isVerified: () => Promise.resolve(opts.verified),
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
        sendReportToJurisdiction: () => Promise.reject(new Error("unused")),
        compose: () => Promise.reject(new Error("unused")),
        appendOutbound: () => Promise.reject(new Error("unused")),
      },
    })
    return { repo: r, svc, sends }
  }

  async function seedEvent(
    r: InMemoryCleanupRepository,
    svc: CleanupService,
    geoid: string | null,
  ): Promise<string> {
    const dto = await svc.createCleanup(baseInput({ title: "Park Cleanup" }), ORG)
    const stored = r.cleanups.get(dto.id)
    if (stored) stored.jurisdictionGeoid = geoid
    return dto.id
  }

  it("happy path: verified host -> event thread send + resource_request timeline row", async () => {
    const { repo: r, svc, sends } = harness({
      verified: true,
      contact: { geoid: "0644000", email: "events@lacity.gov" },
    })
    const id = await seedEvent(r, svc, "0644000")
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

  it("throttles a repeat resource request for the same event + host (cooldown)", async () => {
    const { repo: r, svc, sends } = harness({
      verified: true,
      contact: { geoid: "0644000", email: "events@lacity.gov" },
    })
    const id = await seedEvent(r, svc, "0644000")
    const first = await svc.requestResources({ cleanupId: id, message: "Need bags.", actorId: ORG })
    expect(first).toEqual({ ok: true })
    await expect(
      svc.requestResources({ cleanupId: id, message: "Need bags again.", actorId: ORG }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
    expect(sends).toHaveLength(1)
  })

  it("403s a non-host (and sends nothing)", async () => {
    const { repo: r, svc, sends } = harness({
      verified: true,
      contact: { geoid: "0644000", email: "events@lacity.gov" },
    })
    const id = await seedEvent(r, svc, "0644000")
    await expect(
      svc.requestResources({ cleanupId: id, message: "hi", actorId: ALICE }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(sends).toHaveLength(0)
  })

  it("403s a host who is NOT identity-verified", async () => {
    const { repo: r, svc, sends } = harness({
      verified: false,
      contact: { geoid: "0644000", email: "events@lacity.gov" },
    })
    const id = await seedEvent(r, svc, "0644000")
    await expect(
      svc.requestResources({ cleanupId: id, message: "hi", actorId: ORG }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(sends).toHaveLength(0)
  })

  it("422 NOT_ROUTABLE when the jurisdiction has no contact on file", async () => {
    const { repo: r, svc, sends } = harness({ verified: true, contact: null })
    const id = await seedEvent(r, svc, "0644000")
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

    // Cohost removes a plain member.
    const byCohost = await svc.removeMember(id, ALICE, BOB)
    expect(byCohost).toEqual({ ok: true, going: 2 })
    expect(await repo.isMember(id, BOB)).toBe(false)

    // Organizer removes the cohost.
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
    // Cohorts sort after the organizer, before plain members.
    expect(roster.attendees.map((p) => p.name)).toEqual(["Olive Organizer", "Alice", "Bob"])
  })
})
