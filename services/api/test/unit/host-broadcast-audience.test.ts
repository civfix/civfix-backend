import type { BroadcastKind } from "@civfix/shared"
import { describe, expect, it } from "vitest"
import { InMemoryBroadcastRepository } from "../../src/services/host/broadcast-repository.memory.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"
const TYPE_A = "00000000-0000-0000-0000-00000000aaaa"
const TYPE_B = "00000000-0000-0000-0000-00000000bbbb"
const SLOT = "00000000-0000-0000-0000-00000000ssss".replace(/s/g, "5")

function u(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`
}

function seed(): InMemoryBroadcastRepository {
  const repo = new InMemoryBroadcastRepository()
  repo.seedMembers(EVENT, [
    { userId: u(1), ticketTypeId: TYPE_A, checkedIn: true, slotId: SLOT },
    { userId: u(2), ticketTypeId: TYPE_B },
    { userId: u(3), waitlisted: true, registered: false },
    { userId: u(4), ticketTypeId: TYPE_A, banned: true },
    { userId: u(5), ticketTypeId: TYPE_A, deleted: true },
    { userId: u(6), ticketTypeId: TYPE_A, suspended: true },
    { userId: u(7), ticketTypeId: TYPE_A, hostBroadcastsPref: false },
  ])
  repo.seedGuests(EVENT, [
    { guestId: u(11), ticketTypeId: TYPE_A },
    { guestId: u(12), cancelled: true },
    { guestId: u(13), scrubbed: true },
  ])
  return repo
}

async function resolve(
  repo: InMemoryBroadcastRepository,
  segment: Parameters<InMemoryBroadcastRepository["audiencePage"]>[0]["segment"],
  kind: BroadcastKind = "host_broadcast",
): Promise<{ members: string[]; guests: string[] }> {
  return repo.audiencePage({
    cleanupId: EVENT,
    segment,
    kind,
    afterMember: null,
    afterGuest: null,
    limit: 100,
  })
}

describe("broadcast audience", () => {
  it("all_registered includes registered members and contactable guests", async () => {
    const result = await resolve(seed(), { kind: "all_registered" })
    expect(result.members).toEqual([u(1), u(2)])
    expect(result.guests).toEqual([u(11)])
  })

  it("excludes banned, deleted and suspended members for every kind", async () => {
    const bulk = await resolve(seed(), { kind: "all_registered" })
    const critical = await resolve(seed(), { kind: "all_registered" }, "event_cancelled")
    for (const result of [bulk, critical]) {
      expect(result.members).not.toContain(u(4))
      expect(result.members).not.toContain(u(5))
      expect(result.members).not.toContain(u(6))
    }
  })

  it("excludes cancelled and scrubbed guests", async () => {
    const result = await resolve(seed(), { kind: "all_registered" }, "event_cancelled")
    expect(result.guests).not.toContain(u(12))
    expect(result.guests).not.toContain(u(13))
  })

  it("applies the host_broadcasts opt-out to HOST-COMPOSED kinds only", async () => {
    const repo = seed()
    for (const kind of ["host_broadcast", "thank_you"] as const) {
      const result = await resolve(repo, { kind: "all_registered" }, kind)
      expect(result.members, kind).not.toContain(u(7))
    }
    for (const kind of [
      "reminder",
      "confirmation",
      "waitlist_promoted",
      "event_updated",
      "event_cancelled",
    ] as const) {
      const result = await resolve(repo, { kind: "all_registered" }, kind)
      expect(result.members, kind).toContain(u(7))
    }
  })

  it("still applies unsubscribes and mutes to the service kinds the host_broadcasts toggle does not gate", async () => {
    const repo = seed()
    await repo.setEventMute(EVENT, u(1), true)
    await repo.recordUnsubscribe({
      scope: "global",
      cleanupId: null,
      subjectKind: "user",
      subjectId: u(2),
    })
    const reminders = await resolve(repo, { kind: "all_registered" }, "reminder")
    expect(reminders.members).not.toContain(u(1))
    expect(reminders.members).not.toContain(u(2))
  })

  it("honours an event unsubscribe for bulk and bypasses it for critical", async () => {
    const repo = seed()
    await repo.recordUnsubscribe({
      scope: "event",
      cleanupId: EVENT,
      subjectKind: "user",
      subjectId: u(1),
    })
    expect((await resolve(repo, { kind: "all_registered" })).members).not.toContain(u(1))
    expect((await resolve(repo, { kind: "all_registered" }, "event_cancelled")).members).toContain(
      u(1),
    )
  })

  it("honours a global unsubscribe for bulk", async () => {
    const repo = seed()
    await repo.recordUnsubscribe({
      scope: "global",
      cleanupId: null,
      subjectKind: "user",
      subjectId: u(2),
    })
    expect((await resolve(repo, { kind: "all_registered" })).members).not.toContain(u(2))
  })

  it("honours a per-event mute for bulk and bypasses it for critical", async () => {
    const repo = seed()
    await repo.setEventMute(EVENT, u(2), true)
    expect((await resolve(repo, { kind: "all_registered" })).members).not.toContain(u(2))
    expect((await resolve(repo, { kind: "all_registered" }, "event_cancelled")).members).toContain(
      u(2),
    )
  })

  it("honours a guest unsubscribe for bulk", async () => {
    const repo = seed()
    await repo.recordUnsubscribe({
      scope: "event",
      cleanupId: EVENT,
      subjectKind: "guest",
      subjectId: u(11),
    })
    expect((await resolve(repo, { kind: "all_registered" })).guests).toEqual([])
  })

  it("resolves ticket_types, slots, waitlist, checked_in and not_checked_in", async () => {
    const repo = seed()
    expect((await resolve(repo, { kind: "ticket_types", ids: [TYPE_B] })).members).toEqual([u(2)])
    expect((await resolve(repo, { kind: "slots", ids: [SLOT] })).members).toEqual([u(1)])
    expect((await resolve(repo, { kind: "waitlist" })).members).toEqual([u(3)])
    expect((await resolve(repo, { kind: "checked_in" })).members).toEqual([u(1)])
    expect((await resolve(repo, { kind: "not_checked_in" })).members).toEqual([u(2)])
  })

  it("guests_only resolves no members", async () => {
    const result = await resolve(seed(), { kind: "guests_only" })
    expect(result.members).toEqual([])
    expect(result.guests).toEqual([u(11)])
  })

  it("resolves the GUEST half of every segment, and only slots comes back empty", async () => {
    const repo = new InMemoryBroadcastRepository()
    repo.seedMembers(EVENT, [])
    repo.seedGuests(EVENT, [
      { guestId: u(21), ticketTypeId: TYPE_A, checkedIn: true },
      { guestId: u(22), ticketTypeId: TYPE_B },
      { guestId: u(23), waitlisted: true, registered: false },
    ])

    // all_registered / guests_only select cleanup_guests DIRECTLY, with no join to a registration: a
    // verified RSVP is the membership, so a guest whose seat write was swallowed still hears from the
    // host. u(23) is on the waitlist only and is in this segment for the same reason.
    expect((await resolve(repo, { kind: "all_registered" })).guests).toEqual([u(21), u(22), u(23)])
    expect((await resolve(repo, { kind: "guests_only" })).guests).toEqual([u(21), u(22), u(23)])
    expect((await resolve(repo, { kind: "ticket_types", ids: [TYPE_B] })).guests).toEqual([u(22)])
    expect((await resolve(repo, { kind: "waitlist" })).guests).toEqual([u(23)])
    expect((await resolve(repo, { kind: "checked_in" })).guests).toEqual([u(21)])
    expect((await resolve(repo, { kind: "not_checked_in" })).guests).toEqual([u(22)])
    // A guest can never hold a slot claim (cleanup_slot_claims is user_id-keyed).
    expect((await resolve(repo, { kind: "slots", ids: [SLOT] })).guests).toEqual([])
  })

  it("excludes a guest with no email address at all: there is no other channel for them", async () => {
    const repo = new InMemoryBroadcastRepository()
    repo.seedMembers(EVENT, [])
    repo.seedGuests(EVENT, [
      { guestId: u(31), email: null },
      { guestId: u(32), email: "grace@example.org" },
    ])
    for (const kind of ["host_broadcast", "event_cancelled"] as const) {
      expect((await resolve(repo, { kind: "all_registered" }, kind)).guests, kind).toEqual([u(32)])
    }
  })

  it("keeps a guest unsubscribe OFF the critical lanes, exactly like a member's", async () => {
    const repo = seed()
    await repo.recordUnsubscribe({
      scope: "event",
      cleanupId: EVENT,
      subjectKind: "guest",
      subjectId: u(11),
    })
    for (const kind of ["event_updated", "event_cancelled"] as const) {
      expect((await resolve(repo, { kind: "all_registered" }, kind)).guests, kind).toEqual([u(11)])
    }
    for (const kind of ["host_broadcast", "announcement", "reminder", "thank_you"] as const) {
      expect((await resolve(repo, { kind: "all_registered" }, kind)).guests, kind).toEqual([])
    }
  })

  it("honours a GLOBAL guest unsubscribe for bulk", async () => {
    const repo = seed()
    await repo.recordUnsubscribe({
      scope: "global",
      cleanupId: null,
      subjectKind: "guest",
      subjectId: u(11),
    })
    expect((await resolve(repo, { kind: "all_registered" })).guests).toEqual([])
    expect((await resolve(repo, { kind: "all_registered" }, "event_cancelled")).guests).toEqual([
      u(11),
    ])
  })

  it("keeps cancelled and scrubbed guests out of the guests_only segment too", async () => {
    const result = await resolve(seed(), { kind: "guests_only" }, "event_cancelled")
    expect(result.guests).toEqual([u(11)])
  })

  it("pages by keyset independently per recipient kind", async () => {
    const repo = seed()
    const first = await repo.audiencePage({
      cleanupId: EVENT,
      segment: { kind: "all_registered" },
      kind: "event_cancelled",
      afterMember: null,
      afterGuest: null,
      limit: 1,
    })
    expect(first.members).toHaveLength(1)
    const second = await repo.audiencePage({
      cleanupId: EVENT,
      segment: { kind: "all_registered" },
      kind: "event_cancelled",
      afterMember: first.members[0] ?? null,
      afterGuest: null,
      limit: 10,
    })
    expect(second.members).not.toContain(first.members[0])
  })
})
