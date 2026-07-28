/**
 * P9 signup slots — the SERVICE half (B22–B26), against the in-memory CleanupRepository.
 *
 * The claim/release transaction has its own file (cleanup-slots-claim.test.ts); this one pins the
 * host-authoring side, where every interesting rule is a REFUSAL that has to happen before a row is
 * touched:
 *
 *   - the reconcile diff itself (add / update / delete, and that `[]` clears the board while OMITTING
 *     the key leaves it alone);
 *   - a slot id belonging to ANOTHER event is a hard 422, never a quiet re-parent (B23) — the single
 *     nastiest failure mode here, because a silent insert would move someone else's roster row;
 *   - case-insensitive duplicate titles 422 DETERMINISTICALLY, before cleanup_slots_cleanup_title_uidx
 *     fires (a raw constraint violation would surface as an unactionable 500);
 *   - the cap and the slur gate, on the same footing as bring/title/reason;
 *   - slots are refused on a done/cancelled event (B26) — deleting a slot after completion rewrites the
 *     roster the credited hours were attested against;
 *   - lowering capacity below the live claim count is ALLOWED and evicts nobody (B25);
 *   - slots are legal on BOTH eventKind values, unlike linkedReportIds.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { MAX_EVENT_SLOTS, type AppError } from "@civfix/shared"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { makeCleanupService, type CleanupService } from "../../src/services/cleanup-service.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"

const ORG = "11111111-1111-1111-1111-111111111111"
const COHOST = "22222222-2222-2222-2222-222222222222"
const MEMBER = "33333333-3333-3333-3333-333333333333"
const OTHER = "44444444-4444-4444-4444-444444444444"

const CLEANUP_ID = "aaaaaaaa-0000-0000-0000-000000000001"
const OTHER_CLEANUP_ID = "aaaaaaaa-0000-0000-0000-000000000002"

const FUTURE = new Date(Date.now() + 7 * 86_400_000)

let repo: InMemoryCleanupRepository
let service: CleanupService
/**
 * Per-test counter store. A service built WITHOUT one falls back to a PROCESS-WIDE singleton
 * (cleanup-service.ts `fallbackCounters`), so every test in the file would otherwise share one
 * (event, user) flip budget and the later ones would 429 for no reason of their own.
 */
let counters: InMemoryCounterStore

function seedEvent(
  id: string = CLEANUP_ID,
  over: { status?: "upcoming" | "done" | "cancelled"; eventKind?: "cleanup" | "other_volunteer" } = {},
): string {
  repo.seedCleanup({
    id,
    organizerUserId: ORG,
    scheduledAt: FUTURE,
    ...(over.status !== undefined ? { status: over.status } : {}),
    ...(over.eventKind !== undefined ? { eventKind: over.eventKind } : {}),
  })
  repo.seedMember(id, COHOST, "cohost")
  repo.seedMember(id, MEMBER, "member")
  return id
}

/** The service's error payload, so a test can assert WHICH field was named. */
function fieldsOf(err: unknown): Record<string, string> {
  return (err as AppError).fields as Record<string, string>
}

beforeEach(() => {
  repo = new InMemoryCleanupRepository()
  repo.seedUser({ id: ORG, displayName: "Olive Organizer", handle: "olive" })
  repo.seedUser({ id: COHOST, displayName: "Casey Cohost", handle: "casey" })
  repo.seedUser({ id: MEMBER, displayName: "Mel Member", handle: "mel" })
  repo.seedUser({ id: OTHER, displayName: "Otto Other", handle: "otto" })
  counters = new InMemoryCounterStore(() => 0)
  service = makeCleanupService({ repo, counters })
})

describe("createCleanup — slots ride the create transaction (B22)", () => {
  it("creates the slots with the event and returns the hydrated board", async () => {
    const dto = await service.createCleanup(
      {
        title: "Beach sweep",
        type: "site",
        eventKind: "cleanup",
        lat: 34,
        lng: -118.49,
        scheduledAt: FUTURE.toISOString(),
        slots: [
          { title: "Grill", capacity: 2 },
          { title: "Registration table", description: "Front gate", capacity: null },
        ],
      },
      ORG,
    )

    expect(dto.slots.map((s) => s.title)).toEqual(["Grill", "Registration table"])
    // Array position becomes the board order: the host's list order IS the presentation order.
    expect(dto.slots.map((s) => s.sortOrder)).toEqual([0, 1])
    expect(dto.slots[0]?.capacity).toBe(2)
    // capacity null = unlimited, and the DTO omits the key rather than sending null.
    expect(dto.slots[1]?.capacity).toBeUndefined()
    expect(dto.slots.every((s) => s.claimed === 0)).toBe(true)
  })

  it("accepts slots on an other_volunteer event (unlike linkedReportIds)", async () => {
    // The kind gate that exists for linked reports deliberately does NOT exist for slots: a food-bank
    // shift or a phone bank is precisely the kind of event with named roles.
    const dto = await service.createCleanup(
      {
        title: "Phone bank",
        type: "site",
        eventKind: "other_volunteer",
        lat: 34,
        lng: -118.49,
        scheduledAt: FUTURE.toISOString(),
        slots: [{ title: "Dialer" }],
      },
      ORG,
    )
    expect(dto.eventKind).toBe("other_volunteer")
    expect(dto.slots.map((s) => s.title)).toEqual(["Dialer"])
  })

  it("ignores a client-supplied id on create (there is nothing to edit yet)", async () => {
    const dto = await service.createCleanup(
      {
        title: "Sweep",
        type: "site",
        eventKind: "cleanup",
        lat: 34,
        lng: -118.49,
        scheduledAt: FUTURE.toISOString(),
        slots: [{ id: "99999999-9999-9999-9999-999999999999", title: "Grill" }],
      },
      ORG,
    )
    // A fresh row, NOT the id the client sent — which is what makes a foreign id harmless here.
    expect(dto.slots).toHaveLength(1)
    expect(dto.slots[0]?.id).not.toBe("99999999-9999-9999-9999-999999999999")
  })

  it("omitting slots creates an event with none", async () => {
    const dto = await service.createCleanup(
      {
        title: "Sweep",
        type: "site",
        eventKind: "cleanup",
        lat: 34,
        lng: -118.49,
        scheduledAt: FUTURE.toISOString(),
      },
      ORG,
    )
    expect(dto.slots).toEqual([])
  })
})

describe("updateCleanup — the reconcile diff (B23)", () => {
  it("adds, updates and deletes to match the FULL desired set", async () => {
    const id = seedEvent()
    const keep = repo.seedSlot({ cleanupId: id, title: "Grill", capacity: 2, sortOrder: 0 })
    repo.seedSlot({ cleanupId: id, title: "Cleanup crew", sortOrder: 1 })

    const dto = await service.updateCleanup(
      id,
      {
        slots: [
          { id: keep.id, title: "Grill duty", capacity: 4, sortOrder: 0 },
          { title: "Sign-in", sortOrder: 1 },
        ],
      },
      ORG,
    )

    // The kept row is UPDATED in place — its id survives the rename, which is the whole reason slots
    // carry a surrogate uuid instead of an ordinal key.
    expect(dto.slots.map((s) => [s.id === keep.id, s.title, s.capacity])).toEqual([
      [true, "Grill duty", 4],
      [false, "Sign-in", undefined],
    ])
    // "Cleanup crew" is absent from the desired set, so it is gone.
    expect(repo.slots.filter((s) => s.cleanupId === id).map((s) => s.title).sort()).toEqual([
      "Grill duty",
      "Sign-in",
    ])
  })

  it("sending [] deletes every slot; OMITTING the key leaves them untouched", async () => {
    const id = seedEvent()
    repo.seedSlot({ cleanupId: id, title: "Grill" })

    const untouched = await service.updateCleanup(id, { title: "Renamed" }, ORG)
    expect(untouched.slots.map((s) => s.title)).toEqual(["Grill"])

    const cleared = await service.updateCleanup(id, { slots: [] }, ORG)
    expect(cleared.slots).toEqual([])
    expect(repo.slots.filter((s) => s.cleanupId === id)).toEqual([])
  })

  it("422s an id that belongs to ANOTHER event and writes NOTHING (never a silent re-parent)", async () => {
    const id = seedEvent()
    seedEvent(OTHER_CLEANUP_ID)
    const foreign = repo.seedSlot({ cleanupId: OTHER_CLEANUP_ID, title: "Someone else's grill" })
    repo.seedSlot({ cleanupId: id, title: "Mine" })

    await expect(
      service.updateCleanup(id, { slots: [{ id: foreign.id, title: "Stolen" }] }, ORG),
    ).rejects.toMatchObject({ code: "VALIDATION" })

    // All-or-nothing: the foreign row still belongs to the other event AND this event's own board is
    // untouched (the refusal precedes every write, exactly as the SQL transaction's does).
    expect(repo.slots.find((s) => s.id === foreign.id)?.cleanupId).toBe(OTHER_CLEANUP_ID)
    expect(repo.slots.find((s) => s.id === foreign.id)?.title).toBe("Someone else's grill")
    expect(repo.slots.filter((s) => s.cleanupId === id).map((s) => s.title)).toEqual(["Mine"])
  })

  it("names the unknown id in the 422 payload", async () => {
    const id = seedEvent()
    const unknown = "55555555-5555-5555-5555-555555555555"
    await expect(
      service.updateCleanup(id, { slots: [{ id: unknown, title: "Ghost" }] }, ORG),
    ).rejects.toSatisfy((err: unknown) => fieldsOf(err).slots === `unknown slot: ${unknown}`)
  })

  it("a cohost may edit the board (same gate as the rest of updateCleanup)", async () => {
    const id = seedEvent()
    const dto = await service.updateCleanup(id, { slots: [{ title: "Grill" }] }, COHOST)
    expect(dto.slots.map((s) => s.title)).toEqual(["Grill"])
  })

  it("403s a non-host trying to edit the board", async () => {
    const id = seedEvent()
    await expect(
      service.updateCleanup(id, { slots: [{ title: "Grill" }] }, MEMBER),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})

describe("slot validation happens BEFORE the database is touched (B26)", () => {
  it("422s more than MAX_EVENT_SLOTS entries", async () => {
    const id = seedEvent()
    const tooMany = Array.from({ length: MAX_EVENT_SLOTS + 1 }, (_, i) => ({ title: `Slot ${i}` }))
    await expect(service.updateCleanup(id, { slots: tooMany }, ORG)).rejects.toMatchObject({
      code: "VALIDATION",
    })
    expect(repo.slots).toEqual([])
  })

  it("422s case-insensitive duplicate titles deterministically, before the unique index fires", async () => {
    const id = seedEvent()
    await expect(
      service.updateCleanup(id, { slots: [{ title: "Grill" }, { title: "  gRiLl " }] }, ORG),
    ).rejects.toSatisfy((err: unknown) => fieldsOf(err).slots === "duplicate slot title:   gRiLl ")
    // Nothing was inserted: a raw 23505 from cleanup_slots_cleanup_title_uidx would have surfaced as an
    // unactionable 500 AFTER the first row landed.
    expect(repo.slots).toEqual([])
  })

  it("422s a slur in a slot TITLE (host text rendered to every attendee)", async () => {
    const id = seedEvent()
    await expect(
      service.updateCleanup(id, { slots: [{ title: "retard duty" }] }, ORG),
    ).rejects.toSatisfy((err: unknown) => fieldsOf(err).slots !== undefined)
    expect(repo.slots).toEqual([])
  })

  it("422s a slur in a slot DESCRIPTION too (both fields get the gate)", async () => {
    const id = seedEvent()
    await expect(
      service.updateCleanup(id, { slots: [{ title: "Grill", description: "no faggots" }] }, ORG),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(repo.slots).toEqual([])
  })

  it("general profanity still PASSES (this filter is slurs only)", async () => {
    const id = seedEvent()
    const dto = await service.updateCleanup(id, { slots: [{ title: "Damn hard sweep" }] }, ORG)
    expect(dto.slots.map((s) => s.title)).toEqual(["Damn hard sweep"])
  })

  it("422s slot changes on a DONE event (the roster hours were attested against stops moving)", async () => {
    const id = seedEvent(CLEANUP_ID, { status: "done" })
    repo.seedSlot({ cleanupId: id, title: "Grill" })
    await expect(service.updateCleanup(id, { slots: [] }, ORG)).rejects.toSatisfy(
      (err: unknown) =>
        fieldsOf(err).slots === "slots can't be changed after an event is completed",
    )
    expect(repo.slots.filter((s) => s.cleanupId === id)).toHaveLength(1)
  })

  it("422s slot changes on a CANCELLED event", async () => {
    const id = seedEvent(CLEANUP_ID, { status: "cancelled" })
    await expect(
      service.updateCleanup(id, { slots: [{ title: "Grill" }] }, ORG),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("the REST of updateCleanup stays ungated on status (only slots are refused)", async () => {
    const id = seedEvent(CLEANUP_ID, { status: "done" })
    const dto = await service.updateCleanup(id, { title: "Renamed after the fact" }, ORG)
    expect(dto.title).toBe("Renamed after the fact")
  })
})

describe("capacity lowered below the live claim count (B25)", () => {
  it("is allowed, evicts nobody, and leaves the slot over-subscribed", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill", capacity: 4 })
    await service.claimEventSlot(id, MEMBER, slot.id)
    await service.claimEventSlot(id, COHOST, slot.id)
    await service.claimEventSlot(id, OTHER, slot.id)

    const dto = await service.updateCleanup(
      id,
      { slots: [{ id: slot.id, title: "Grill", capacity: 1 }] },
      ORG,
    )

    // There is no fair rule for choosing which claimant loses their shift, so nobody does. The DTO
    // carries BOTH numbers so the UI can render "3/1" honestly instead of clamping to a lie.
    const board = dto.slots[0]!
    expect(board.capacity).toBe(1)
    expect(board.claimed).toBe(3)
    expect(repo.slotClaims.filter((c) => c.slotId === slot.id)).toHaveLength(3)
  })

  it("the over-subscribed slot then refuses NEW claims", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill", capacity: 2 })
    await service.claimEventSlot(id, MEMBER, slot.id)
    await service.claimEventSlot(id, COHOST, slot.id)
    await service.updateCleanup(id, { slots: [{ id: slot.id, title: "Grill", capacity: 1 }] }, ORG)

    await expect(service.claimEventSlot(id, OTHER, slot.id)).rejects.toMatchObject({
      code: "CONFLICT",
    })
  })
})

describe("the cleanup_slot bell (B34/B35)", () => {
  it("rings every claimant of a REMOVED slot, actor excluded", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill" })
    await service.claimEventSlot(id, MEMBER, slot.id)
    await service.claimEventSlot(id, COHOST, slot.id)
    await service.claimEventSlot(id, ORG, slot.id)

    const bells: { userId: string; type: string; vars?: Record<string, unknown> }[] = []
    const notified = makeCleanupService({
      repo,
      counters,
      notifier: {
        createNotification: (userId, input) => {
          bells.push({
            userId,
            type: input.type,
            ...(input.vars !== undefined ? { vars: input.vars } : {}),
          })
          return Promise.resolve({ id: "n1" } as never)
        },
      },
    })

    await notified.updateCleanup(id, { slots: [] }, ORG)

    expect(bells.map((b) => b.userId).sort()).toEqual([COHOST, MEMBER].sort())
    expect(bells.every((b) => b.type === "cleanup_slot")).toBe(true)
    // The copy is localized by the pipeline from keys + vars, never composed here.
    expect(bells[0]?.vars).toMatchObject({ slot: "Grill" })
  })

  it("rings NOBODY when the edit only renames or adds (nothing was removed)", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill" })
    await service.claimEventSlot(id, MEMBER, slot.id)

    const bells: string[] = []
    const notified = makeCleanupService({
      repo,
      counters,
      notifier: {
        createNotification: (userId) => {
          bells.push(userId)
          return Promise.resolve({ id: "n1" } as never)
        },
      },
    })

    await notified.updateCleanup(
      id,
      { slots: [{ id: slot.id, title: "Grill duty" }, { title: "Sign-in" }] },
      ORG,
    )
    expect(bells).toEqual([])
  })

  it("B35: claiming a slot rings the host NOT AT ALL", async () => {
    // Deliberate, not an omission: a popular event would ring the organizer once per RSVP for
    // information they can already see on their own roster, and coordination has the event group chat.
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill" })

    const bells: string[] = []
    const notified = makeCleanupService({
      repo,
      counters,
      notifier: {
        createNotification: (userId) => {
          bells.push(userId)
          return Promise.resolve({ id: "n1" } as never)
        },
      },
    })

    await notified.claimEventSlot(id, MEMBER, slot.id)
    expect(bells).toEqual([])
  })

  it("a bell failure never fails the edit, and one bad recipient does not abandon the rest", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill" })
    await service.claimEventSlot(id, MEMBER, slot.id)
    await service.claimEventSlot(id, COHOST, slot.id)

    const reached: string[] = []
    const notified = makeCleanupService({
      repo,
      counters,
      notifier: {
        createNotification: (userId) => {
          reached.push(userId)
          if (userId === MEMBER) return Promise.reject(new Error("prefs row is broken"))
          return Promise.resolve({ id: "n1" } as never)
        },
      },
    })

    const dto = await notified.updateCleanup(id, { slots: [] }, ORG)
    // The edit itself committed...
    expect(dto.slots).toEqual([])
    // ...and the healthy recipient still got their bell (best-effort PER RECIPIENT, not one try/catch
    // around the whole loop).
    expect(reached.sort()).toEqual([COHOST, MEMBER].sort())
  })
})

describe("read shapes (B29a)", () => {
  it("getCleanup hydrates the board with the VIEWER's own `mine` flag", async () => {
    const id = seedEvent()
    const grill = repo.seedSlot({ cleanupId: id, title: "Grill", sortOrder: 0 })
    repo.seedSlot({ cleanupId: id, title: "Sign-in", sortOrder: 1 })
    await service.claimEventSlot(id, MEMBER, grill.id)

    const asMember = await service.getCleanup(id, { userId: MEMBER })
    expect(asMember.slots.map((s) => [s.title, s.claimed, s.mine ?? false])).toEqual([
      ["Grill", 1, true],
      ["Sign-in", 0, false],
    ])

    // Anonymous: the counts are public, the claim is not "mine" for anyone.
    const anon = await service.getCleanup(id, { userId: null })
    expect(anon.slots.map((s) => s.mine ?? false)).toEqual([false, false])
    expect(anon.slots.map((s) => s.claimed)).toEqual([1, 0])
  })

  it("listCleanups reports slotCount and leaves `slots` empty (a feed card renders no board)", async () => {
    const id = seedEvent()
    repo.seedSlot({ cleanupId: id, title: "Grill" })
    repo.seedSlot({ cleanupId: id, title: "Sign-in" })

    const page = await service.listCleanups({ when: "upcoming" }, { userId: MEMBER })
    const card = page.items.find((c) => c.id === id)!
    expect(card.slots).toEqual([])
    // Without this an empty `slots` would be ambiguous between "no slots" and "not hydrated".
    expect(card.slotCount).toBe(2)
  })

  it("listCleanups reports slotCount 0 for an event with no slots", async () => {
    const id = seedEvent()
    const page = await service.listCleanups({ when: "upcoming" }, { userId: MEMBER })
    expect(page.items.find((c) => c.id === id)?.slotCount).toBe(0)
  })

  it("the attendee roster carries each person's slot (no second endpoint — B29b)", async () => {
    const id = seedEvent()
    const grill = repo.seedSlot({ cleanupId: id, title: "Grill" })
    await service.claimEventSlot(id, MEMBER, grill.id)

    const roster = await service.listAttendees(id, { userId: ORG })
    const rows = roster.attendees.map((a) => [a.id, a.slot?.title ?? null])
    expect(rows).toContainEqual([MEMBER, "Grill"])
    // An attendee who RSVP'd without picking a shift carries an explicit null, not a missing key.
    expect(rows).toContainEqual([ORG, null])
  })
})
