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
    expect((await resolve(repo, { kind: "all_registered" }, "event_cancelled")).members).toContain(u(1))
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
    expect((await resolve(repo, { kind: "all_registered" }, "event_cancelled")).members).toContain(u(2))
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
