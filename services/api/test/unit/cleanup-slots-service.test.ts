/**
 * P9 signup slots — the SERVICE half (B22–B26), against the in-memory CleanupRepository.
 *
 * The claim/release transaction has its own file (cleanup-slots-claim.test.ts); this one pins the
 * host-authoring side, where every interesting rule is a REFUSAL that has to happen before a row is
 * touched:
 *
 *   - the reconcile diff itself (add / update / delete, and that `[]` is REFUSED because every event
 *     needs at least one slot, while OMITTING the key leaves the board alone);
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
import {
  CANCEL_FANOUT_MEMBER_CAP,
  makeCleanupService,
  type CleanupService,
} from "../../src/services/cleanup-service.js"
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
  over: {
    status?: "upcoming" | "cancelled"
    ended?: boolean
    eventKind?: "cleanup" | "other_volunteer"
  } = {},
): string {
  const scheduledAt = over.ended === true ? new Date(Date.now() - 8 * 3_600_000) : FUTURE
  repo.seedCleanup({
    id,
    organizerUserId: ORG,
    scheduledAt,
    endsAt: new Date(scheduledAt.getTime() + 4 * 3_600_000),
    withDefaultSlot: false,
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

  it("422s a create with NO slots, naming the field (every event needs a board)", async () => {
    await expect(
      service.createCleanup(
        {
          title: "Sweep",
          type: "site",
          eventKind: "cleanup",
          lat: 34,
          lng: -118.49,
          scheduledAt: FUTURE.toISOString(),
        },
        ORG,
      ),
    ).rejects.toSatisfy(
      (err: unknown) => fieldsOf(err).slots === "An event needs at least one signup slot.",
    )
    // The refusal precedes every write: no orphan event, no membership.
    expect(repo.cleanups.size).toBe(0)
  })

  it("422s an EXPLICITLY empty slots array the same way", async () => {
    await expect(
      service.createCleanup(
        {
          title: "Sweep",
          type: "site",
          eventKind: "cleanup",
          lat: 34,
          lng: -118.49,
          scheduledAt: FUTURE.toISOString(),
          slots: [],
        },
        ORG,
      ),
    ).rejects.toSatisfy(
      (err: unknown) => fieldsOf(err).slots === "An event needs at least one signup slot.",
    )
    expect(repo.cleanups.size).toBe(0)
  })

  it("a single slot is enough", async () => {
    const dto = await service.createCleanup(
      {
        title: "Sweep",
        type: "site",
        eventKind: "cleanup",
        lat: 34,
        lng: -118.49,
        scheduledAt: FUTURE.toISOString(),
        slots: [{ title: "General volunteers" }],
      },
      ORG,
    )
    expect(dto.slots.map((s) => s.title)).toEqual(["General volunteers"])
  })
})

describe("duplicateCleanup — a legacy slot-less source still yields a valid copy", () => {
  it("synthesizes the default slot when the source board is empty", async () => {
    const source = repo.seedCleanup({
      id: CLEANUP_ID,
      organizerUserId: ORG,
      scheduledAt: new Date(Date.now() - 8 * 3_600_000),
      endsAt: new Date(Date.now() - 4 * 3_600_000),
      capacity: 30,
      withDefaultSlot: false,
    })

    const copy = await service.duplicateCleanup(ORG, {
      id: source.id,
      scheduledAt: FUTURE.toISOString(),
      includeTicketTypes: false,
      includeQuestions: false,
      includePage: false,
    })

    expect(copy.slots.map((s) => [s.title, s.capacity, s.startsAt, s.endsAt])).toEqual([
      ["General volunteers", 30, undefined, undefined],
    ])
  })

  it("copies the real board when the source has one", async () => {
    const source = repo.seedCleanup({
      id: CLEANUP_ID,
      organizerUserId: ORG,
      scheduledAt: FUTURE,
      endsAt: new Date(FUTURE.getTime() + 4 * 3_600_000),
      withDefaultSlot: false,
    })
    repo.seedSlot({ cleanupId: source.id, title: "Grill", sortOrder: 0 })
    repo.seedSlot({ cleanupId: source.id, title: "Sign-in", sortOrder: 1 })

    const copy = await service.duplicateCleanup(ORG, {
      id: source.id,
      scheduledAt: new Date(FUTURE.getTime() + 7 * 86_400_000).toISOString(),
      includeTicketTypes: false,
      includeQuestions: false,
      includePage: false,
    })

    expect(copy.slots.map((s) => s.title)).toEqual(["Grill", "Sign-in"])
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

  it("sending [] is REFUSED; OMITTING the key still leaves the board untouched", async () => {
    const id = seedEvent()
    repo.seedSlot({ cleanupId: id, title: "Grill" })

    const untouched = await service.updateCleanup(id, { title: "Renamed" }, ORG)
    expect(untouched.slots.map((s) => s.title)).toEqual(["Grill"])

    await expect(service.updateCleanup(id, { slots: [] }, ORG)).rejects.toSatisfy(
      (err: unknown) => fieldsOf(err).slots === "An event needs at least one signup slot.",
    )
    // The refusal precedes the reconcile, so nothing was deleted on the way to it.
    expect(repo.slots.filter((s) => s.cleanupId === id).map((s) => s.title)).toEqual(["Grill"])
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

  it("SWAPS two slot titles in one save (the write order, not just the final state)", async () => {
    const id = seedEvent()
    const reg = repo.seedSlot({ cleanupId: id, title: "Registration", sortOrder: 0 })
    const grill = repo.seedSlot({ cleanupId: id, title: "Grill", sortOrder: 1 })

    const dto = await service.updateCleanup(
      id,
      {
        slots: [
          { id: reg.id, title: "Grill", sortOrder: 0 },
          { id: grill.id, title: "Registration", sortOrder: 1 },
        ],
      },
      ORG,
    )

    // (cleanup_id, lower(title)) is an IMMEDIATELY-checked unique index, so the first UPDATE of a naive
    // swap writes a title the second row still holds — a raw 23505, i.e. a 500 on an ordinary edit. The
    // repo parks renamed rows on sentinel titles first; both slots keep their identity through it.
    expect(dto.slots.map((s) => [s.id, s.title])).toEqual([
      [reg.id, "Grill"],
      [grill.id, "Registration"],
    ])
  })

  it("REMOVES a slot and re-adds one with the SAME title in one save", async () => {
    const id = seedEvent()
    const old = repo.seedSlot({ cleanupId: id, title: "Grill", capacity: 2 })

    // The other half of the same ordering bug: written before the delete, this INSERT collides with the
    // row it is replacing. The removal has to land first.
    const dto = await service.updateCleanup(id, { slots: [{ title: "Grill", capacity: 5 }] }, ORG)

    expect(dto.slots.map((s) => [s.title, s.capacity])).toEqual([["Grill", 5]])
    // A genuinely NEW row — dropping the id is how a host resets a slot's claimants.
    expect(dto.slots[0]?.id).not.toBe(old.id)
    expect(repo.slots.filter((s) => s.cleanupId === id)).toHaveLength(1)
  })

  it("RENAMES a kept slot onto the title of a slot being removed in the same save", async () => {
    const id = seedEvent()
    const keep = repo.seedSlot({ cleanupId: id, title: "Grill", sortOrder: 0 })
    repo.seedSlot({ cleanupId: id, title: "Registration", sortOrder: 1 })

    const dto = await service.updateCleanup(
      id,
      { slots: [{ id: keep.id, title: "Registration", sortOrder: 0 }] },
      ORG,
    )

    expect(dto.slots.map((s) => [s.id, s.title])).toEqual([[keep.id, "Registration"]])
  })

  it("the repo itself 422s a duplicate title rather than leaking the unique violation", async () => {
    // The service refuses duplicates within the payload first, so this is the repo contract on its own:
    // whatever reaches cleanup_slots_cleanup_title_uidx comes back as a NAMED validation error, never
    // the raw 23505 that http-mapper turns into an unactionable 500.
    const id = seedEvent()
    // Called through an async wrapper because the in-memory twin throws SYNCHRONOUSLY where the drizzle
    // repo rejects its promise; this asserts the error either way.
    await expect(
      (async () =>
        repo.reconcileSlots(
          id,
          [
            { title: "Grill", description: null, capacity: null, startsAt: null, endsAt: null, sortOrder: 0 },
            { title: "GRILL", description: null, capacity: null, startsAt: null, endsAt: null, sortOrder: 1 },
          ],
          ORG,
        ))(),
    ).rejects.toSatisfy((err: unknown) => fieldsOf(err).slots === "duplicate slot title")
  })

  it("names the unknown id in the 422 payload", async () => {
    const id = seedEvent()
    const unknown = "55555555-5555-5555-5555-555555555555"
    await expect(
      service.updateCleanup(id, { slots: [{ id: unknown, title: "Ghost" }] }, ORG),
    ).rejects.toSatisfy((err: unknown) => fieldsOf(err).slots === `unknown slot: ${unknown}`)
  })

  it("a foreign slot id 422s the WHOLE patch — the scalar fields are not written either", async () => {
    const id = seedEvent()
    seedEvent(OTHER_CLEANUP_ID)
    const foreign = repo.seedSlot({ cleanupId: OTHER_CLEANUP_ID, title: "Someone else's grill" })
    const before = repo.cleanups.get(id)!
    const originalTitle = before.title
    const originalScheduledAt = before.scheduledAt
    const later = new Date(FUTURE.getTime() + 86_400_000)

    await expect(
      service.updateCleanup(
        id,
        {
          title: "Moved and renamed",
          description: "New plan",
          scheduledAt: later.toISOString(),
          slots: [{ id: foreign.id, title: "Stolen" }],
        },
        ORG,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" })

    // The reconcile's own refusal fires inside a transaction opened AFTER the scalar UPDATE commits, so
    // without the pre-check the host got a 422 for a save whose title/description/scheduledAt had
    // ALREADY been applied — a half-written PATCH behind an error response. `slots` is validated
    // against the CURRENT board before anything is written.
    const after = repo.cleanups.get(id)!
    expect(after.title).toBe(originalTitle)
    expect(after.description).toBeNull()
    expect(after.scheduledAt).toEqual(originalScheduledAt)
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

  it("422s slot changes on an ENDED event (the roster hours were attested against stops moving)", async () => {
    const id = seedEvent(CLEANUP_ID, { ended: true })
    repo.seedSlot({ cleanupId: id, title: "Grill" })
    await expect(service.updateCleanup(id, { slots: [] }, ORG)).rejects.toSatisfy(
      (err: unknown) => fieldsOf(err).slots === "Slots can't be changed after an event has ended.",
    )
    expect(repo.slots.filter((s) => s.cleanupId === id)).toHaveLength(1)
  })

  it("409s any edit (including slots) on a CANCELLED event", async () => {
    const id = seedEvent(CLEANUP_ID, { status: "cancelled" })
    await expect(
      service.updateCleanup(id, { slots: [{ title: "Grill" }] }, ORG),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("freezes date/title/location/type on an ended event, text corrections still apply (F015)", async () => {
    const id = seedEvent(CLEANUP_ID, { ended: true })
    await expect(
      service.updateCleanup(id, { title: "Renamed after the fact" }, ORG),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    const dto = await service.updateCleanup(
      id,
      { description: "Thanks to everyone who came out" },
      ORG,
    )
    expect(dto.description).toBe("Thanks to everyone who came out")
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

    await notified.updateCleanup(id, { slots: [{ title: "Sign-in" }] }, ORG)

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

    const dto = await notified.updateCleanup(id, { slots: [{ title: "Sign-in" }] }, ORG)
    // The edit itself committed...
    expect(dto.slots.map((s) => s.title)).toEqual(["Sign-in"])
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

describe("slot windows (0167)", () => {
  const EVENT_START = FUTURE
  const EVENT_END = new Date(FUTURE.getTime() + 4 * 60 * 60 * 1000)
  const at = (hours: number): string =>
    new Date(EVENT_START.getTime() + hours * 60 * 60 * 1000).toISOString()

  function seedTimedEvent(id: string = CLEANUP_ID): string {
    repo.seedCleanup({
      id,
      organizerUserId: ORG,
      scheduledAt: EVENT_START,
      endsAt: EVENT_END,
      withDefaultSlot: false,
    })
    repo.seedMember(id, COHOST, "cohost")
    repo.seedMember(id, MEMBER, "member")
    return id
  }

  it("accepts a window inside the event and round-trips it onto the DTO", async () => {
    const id = seedTimedEvent()
    const dto = await service.updateCleanup(
      id,
      { slots: [{ title: "Sweep", startsAt: at(0), endsAt: at(2) }] },
      ORG,
    )
    expect(dto.slots.map((s) => [s.title, s.startsAt, s.endsAt])).toEqual([
      ["Sweep", at(0), at(2)],
    ])
  })

  it("leaves an untimed slot's window keys OFF the DTO entirely", async () => {
    const id = seedTimedEvent()
    const dto = await service.updateCleanup(id, { slots: [{ title: "Grill" }] }, ORG)
    expect(dto.slots[0]?.startsAt).toBeUndefined()
    expect(dto.slots[0]?.endsAt).toBeUndefined()
  })

  it("defaults a create with no endsAt to the 4 h window, so a timed slot inside it is accepted", async () => {
    const created = await service.createCleanup(
      {
        title: "Sweep",
        type: "site",
        eventKind: "cleanup",
        lat: 34,
        lng: -118.49,
        scheduledAt: EVENT_START.toISOString(),
        slots: [{ title: "Sweep", startsAt: at(0), endsAt: at(2) }],
      },
      ORG,
    )
    expect(created.endsAt).toBe(EVENT_END.toISOString())
    expect(created.slots.map((s) => s.title)).toEqual(["Sweep"])
  })

  it("422s a create that clears endsAt outright", async () => {
    await expect(
      service.createCleanup(
        {
          title: "Sweep",
          type: "site",
          eventKind: "cleanup",
          lat: 34,
          lng: -118.49,
          scheduledAt: EVENT_START.toISOString(),
          endsAt: null,
          slots: [{ title: "Sweep", startsAt: at(0), endsAt: at(2) }],
        },
        ORG,
      ),
    ).rejects.toSatisfy((err: unknown) => fieldsOf(err).endsAt === "required")
  })

  it("422s a window that starts before the event does, naming the slot", async () => {
    const id = seedTimedEvent()
    await expect(
      service.updateCleanup(id, { slots: [{ title: "Sweep", startsAt: at(-1), endsAt: at(1) }] }, ORG),
    ).rejects.toSatisfy(
      (err: unknown) => fieldsOf(err).slots === `slot "Sweep" falls outside the event's start and end`,
    )
    expect(repo.slots).toEqual([])
  })

  it("422s a window that runs past the event's end", async () => {
    const id = seedTimedEvent()
    await expect(
      service.updateCleanup(id, { slots: [{ title: "Sweep", startsAt: at(3), endsAt: at(5) }] }, ORG),
    ).rejects.toSatisfy(
      (err: unknown) => fieldsOf(err).slots === `slot "Sweep" falls outside the event's start and end`,
    )
  })

  it("422s a shift shorter than the creditable-event minimum", async () => {
    const id = seedTimedEvent()
    const startsAt = at(0)
    const endsAt = new Date(EVENT_START.getTime() + 10 * 60 * 1000).toISOString()
    await expect(
      service.updateCleanup(id, { slots: [{ title: "Sweep", startsAt, endsAt }] }, ORG),
    ).rejects.toSatisfy(
      (err: unknown) => fieldsOf(err).slots === `slot "Sweep" must last at least 15 minutes`,
    )
  })

  it("accepts the SAME title at two different windows (that is what a shift is)", async () => {
    const id = seedTimedEvent()
    const dto = await service.updateCleanup(
      id,
      {
        slots: [
          { title: "Sweep", startsAt: at(0), endsAt: at(2), sortOrder: 0 },
          { title: "Sweep", startsAt: at(2), endsAt: at(4), sortOrder: 1 },
        ],
      },
      ORG,
    )
    expect(dto.slots.map((s) => [s.title, s.startsAt])).toEqual([
      ["Sweep", at(0)],
      ["Sweep", at(2)],
    ])
  })

  it("still 422s the same title at the SAME window", async () => {
    const id = seedTimedEvent()
    await expect(
      service.updateCleanup(
        id,
        {
          slots: [
            { title: "Sweep", startsAt: at(0), endsAt: at(2) },
            { title: "sweep", startsAt: at(0), endsAt: at(2) },
          ],
        },
        ORG,
      ),
    ).rejects.toSatisfy((err: unknown) => fieldsOf(err).slots === "duplicate slot title: sweep")
    expect(repo.slots).toEqual([])
  })

  it("still 422s two UNTIMED slots sharing a title (0063's rule survives the wider key)", async () => {
    const id = seedTimedEvent()
    await expect(
      service.updateCleanup(id, { slots: [{ title: "Grill" }, { title: "GRILL" }] }, ORG),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("SWAPS the windows of two same-titled shifts in one save", async () => {
    const id = seedTimedEvent()
    const morning = repo.seedSlot({
      cleanupId: id,
      title: "Sweep",
      startsAt: new Date(at(0)),
      endsAt: new Date(at(2)),
      sortOrder: 0,
    })
    const afternoon = repo.seedSlot({
      cleanupId: id,
      title: "Sweep",
      startsAt: new Date(at(2)),
      endsAt: new Date(at(4)),
      sortOrder: 1,
    })

    const dto = await service.updateCleanup(
      id,
      {
        slots: [
          { id: morning.id, title: "Sweep", startsAt: at(2), endsAt: at(4), sortOrder: 0 },
          { id: afternoon.id, title: "Sweep", startsAt: at(0), endsAt: at(2), sortOrder: 1 },
        ],
      },
      ORG,
    )

    expect(dto.slots.map((s) => [s.id, s.startsAt])).toEqual([
      [morning.id, at(2)],
      [afternoon.id, at(0)],
    ])
  })

  it("REMOVES a shift and re-adds one at the same title AND window in one save", async () => {
    const id = seedTimedEvent()
    const old = repo.seedSlot({
      cleanupId: id,
      title: "Sweep",
      startsAt: new Date(at(0)),
      endsAt: new Date(at(2)),
    })

    const dto = await service.updateCleanup(
      id,
      { slots: [{ title: "Sweep", startsAt: at(0), endsAt: at(2), capacity: 5 }] },
      ORG,
    )

    expect(dto.slots.map((s) => [s.title, s.startsAt, s.capacity])).toEqual([["Sweep", at(0), 5]])
    expect(dto.slots[0]?.id).not.toBe(old.id)
  })

  it("422s on scheduledAt when the event window shrinks past a timed slot and slots are OMITTED", async () => {
    const id = seedTimedEvent()
    repo.seedSlot({
      cleanupId: id,
      title: "Sweep",
      startsAt: new Date(at(3)),
      endsAt: new Date(at(4)),
    })

    await expect(
      service.updateCleanup(id, { endsAt: at(2) }, ORG),
    ).rejects.toSatisfy(
      (err: unknown) =>
        fieldsOf(err).scheduledAt ===
        "timed slots would fall outside the new start and end; update the slots in the same save",
    )
    expect(repo.cleanups.get(id)?.endsAt).toEqual(EVENT_END)
  })

  it("422s clearing the event's end entirely — every event must have one", async () => {
    const id = seedTimedEvent()
    repo.seedSlot({
      cleanupId: id,
      title: "Sweep",
      startsAt: new Date(at(0)),
      endsAt: new Date(at(2)),
    })
    await expect(service.updateCleanup(id, { endsAt: null }, ORG)).rejects.toSatisfy(
      (err: unknown) => fieldsOf(err).endsAt === "an event must have an end time",
    )
  })

  it("moves the event freely when only UNTIMED slots exist", async () => {
    const id = seedTimedEvent()
    repo.seedSlot({ cleanupId: id, title: "Grill" })
    const dto = await service.updateCleanup(id, { endsAt: at(2) }, ORG)
    expect(dto.endsAt).toBe(at(2))
  })

  it("accepts a reschedule that carries the shifted slots in the SAME save", async () => {
    const id = seedTimedEvent()
    const slot = repo.seedSlot({
      cleanupId: id,
      title: "Sweep",
      startsAt: new Date(at(3)),
      endsAt: new Date(at(4)),
    })

    const dto = await service.updateCleanup(
      id,
      {
        endsAt: at(2),
        slots: [{ id: slot.id, title: "Sweep", startsAt: at(0), endsAt: at(1) }],
      },
      ORG,
    )
    expect(dto.endsAt).toBe(at(2))
    expect(dto.slots.map((s) => [s.startsAt, s.endsAt])).toEqual([[at(0), at(1)]])
  })

  it("rings every claimant of a MOVED shift exactly once, actor excluded", async () => {
    const id = seedTimedEvent()
    const slot = repo.seedSlot({
      cleanupId: id,
      title: "Sweep",
      startsAt: new Date(at(0)),
      endsAt: new Date(at(2)),
    })
    await service.claimEventSlot(id, MEMBER, slot.id)
    await service.claimEventSlot(id, COHOST, slot.id)
    await service.claimEventSlot(id, ORG, slot.id)

    const bells: { userId: string; titleKey?: string; vars?: Record<string, unknown> }[] = []
    const notified = makeCleanupService({
      repo,
      counters,
      notifier: {
        createNotification: (userId, input) => {
          bells.push({
            userId,
            ...(input.titleKey !== undefined ? { titleKey: input.titleKey } : {}),
            ...(input.vars !== undefined ? { vars: input.vars } : {}),
          })
          return Promise.resolve({ id: "n1" } as never)
        },
      },
    })

    await notified.updateCleanup(
      id,
      { slots: [{ id: slot.id, title: "Sweep", startsAt: at(2), endsAt: at(4) }] },
      ORG,
    )

    expect(bells.map((b) => b.userId).sort()).toEqual([COHOST, MEMBER].sort())
    expect(bells.every((b) => b.titleKey === "notification.cleanup_slot.moved.title")).toBe(true)
    expect(bells[0]?.vars).toMatchObject({ slot: "Sweep" })
  })

  it("rings NOBODY when the shift keeps its window (a rename is not a reschedule)", async () => {
    const id = seedTimedEvent()
    const slot = repo.seedSlot({
      cleanupId: id,
      title: "Sweep",
      startsAt: new Date(at(0)),
      endsAt: new Date(at(2)),
    })
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
      { slots: [{ id: slot.id, title: "Morning sweep", startsAt: at(0), endsAt: at(2), capacity: 9 }] },
      ORG,
    )
    expect(bells).toEqual([])
  })

  it("spends ONE fan-out budget across the removed and moved bells in a single save", async () => {
    const id = seedTimedEvent()
    const slot = repo.seedSlot({
      cleanupId: id,
      title: "Sweep",
      startsAt: new Date(at(0)),
      endsAt: new Date(at(2)),
    })
    const crowd = (prefix: string): string[] =>
      Array.from({ length: CANCEL_FANOUT_MEMBER_CAP }, (_, i) => `${prefix}-${i}`)
    repo.reconcileSlots = () =>
      Promise.resolve({
        added: [],
        updated: [slot.id],
        removed: [{ slotId: "removed-slot", title: "Grill", claimantUserIds: crowd("gone") }],
        rescheduled: [{ slotId: slot.id, title: "Sweep", claimantUserIds: crowd("moved") }],
      })

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
      { slots: [{ id: slot.id, title: "Sweep", startsAt: at(2), endsAt: at(4) }] },
      ORG,
    )

    expect(bells).toHaveLength(CANCEL_FANOUT_MEMBER_CAP)
    expect(bells.every((userId) => userId.startsWith("gone-"))).toBe(true)
  })

  it("rings nobody for a moved shift that has no claimants", async () => {
    const id = seedTimedEvent()
    const slot = repo.seedSlot({
      cleanupId: id,
      title: "Sweep",
      startsAt: new Date(at(0)),
      endsAt: new Date(at(2)),
    })

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
      { slots: [{ id: slot.id, title: "Sweep", startsAt: at(2), endsAt: at(4) }] },
      ORG,
    )
    expect(bells).toEqual([])
  })
})
