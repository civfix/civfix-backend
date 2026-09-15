/**
 * P9 signup slots — the CLAIM half (B27/B28), against the in-memory CleanupRepository.
 *
 * `PUT /cleanups/:id/slot` is ONE endpoint for claim, MOVE and release, because the v1 rule is exactly
 * one slot per person per event, so "my slot on this event" is a singular resource. That shape is what
 * makes a move atomic: a release+claim pair could release successfully and then find the target full,
 * leaving the volunteer with nothing.
 *
 * The rules pinned here are the ones a reader would otherwise have to reconstruct from the SQL:
 *
 *   - claiming AUTO-RSVPs a non-member (B28b) — picking a shift IS an RSVP — but the BAN probe runs
 *     first, so a removed attendee cannot re-enter through the slot door (M17's whole point);
 *   - an idempotent re-claim of a slot you already hold must NOT run the capacity check, or it 409s on
 *     a full slot you are already sitting in;
 *   - releasing does NOT leave the event: asymmetric on purpose;
 *   - claiming is refused on a done/cancelled event (B28e), because logEventHours requires current
 *     membership and the auto-RSVP would therefore be a credit-laundering path;
 *   - leaving and being removed both FREE the seat (B28d) — otherwise a departed attendee occupies a
 *     phantom-full slot forever.
 *
 * The genuinely concurrent half (N racers on a capacity-1 slot) can only be shown against a real
 * database and lives in test/integration/cleanup-slots-pg.test.ts.
 */

import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"
import { describe, it, expect, beforeEach } from "vitest"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import {
  makeCleanupService,
  SLOT_FLIPS_PER_EVENT_PER_WINDOW,
  type CleanupService,
} from "../../src/services/cleanup-service.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"

const ORG = "11111111-1111-1111-1111-111111111111"
const COHOST = "22222222-2222-2222-2222-222222222222"
const MEMBER = "33333333-3333-3333-3333-333333333333"
const OUTSIDER = "44444444-4444-4444-4444-444444444444"
const MISSING = "00000000-0000-0000-0000-000000000000"

const CLEANUP_ID = "aaaaaaaa-0000-0000-0000-000000000001"
const OTHER_CLEANUP_ID = "aaaaaaaa-0000-0000-0000-000000000002"

const FUTURE = new Date(Date.now() + 7 * 86_400_000)

let repo: InMemoryCleanupRepository
let service: CleanupService
/**
 * Per-test counter store. A service constructed WITHOUT one falls back to a module-level singleton
 * (cleanup-service.ts `fallbackCounters`), which is process-wide — so without this every test in the
 * file would spend the same (event, user) flip budget and the later ones would 429 for no reason.
 */
let counters: InMemoryCounterStore

function seedEvent(
  id: string = CLEANUP_ID,
  over: { status?: "upcoming" | "done" | "cancelled" } = {},
): string {
  repo.seedCleanup({
    id,
    organizerUserId: ORG,
    scheduledAt: FUTURE,
    withDefaultSlot: false,
    ...(over.status !== undefined ? { status: over.status } : {}),
  })
  repo.seedMember(id, COHOST, "cohost")
  repo.seedMember(id, MEMBER, "member")
  return id
}

beforeEach(() => {
  repo = new InMemoryCleanupRepository()
  repo.seedUser({ id: ORG, displayName: "Olive Organizer", handle: "olive" })
  repo.seedUser({ id: COHOST, displayName: "Casey Cohost", handle: "casey" })
  repo.seedUser({ id: MEMBER, displayName: "Mel Member", handle: "mel" })
  repo.seedUser({ id: OUTSIDER, displayName: "Ollie Outsider", handle: "ollie" })
  counters = new InMemoryCounterStore(() => 0)
  service = makeCleanupService({ tickets: TEST_TICKET_SIGNER, repo, counters })
})

describe("claim", () => {
  it("claims a slot and returns the refreshed DETAIL DTO (no refetch needed)", async () => {
    const id = seedEvent()
    const grill = repo.seedSlot({ cleanupId: id, title: "Grill", capacity: 2, sortOrder: 0 })
    repo.seedSlot({ cleanupId: id, title: "Sign-in", sortOrder: 1 })

    const dto = await service.claimEventSlot(id, MEMBER, grill.id)

    // C5: the response IS GetCleanupResponse — it already carries the refreshed board (with `claimed`
    // and `mine`), `joined` and `going`, which is why the contract has no bespoke claim response.
    expect(dto.slots.map((s) => [s.title, s.claimed, s.mine ?? false])).toEqual([
      ["Grill", 1, true],
      ["Sign-in", 0, false],
    ])
    expect(dto.joined).toBe(true)
    expect(await repo.slotOf(id, MEMBER)).toBe(grill.id)
  })

  it("409s a FULL slot", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill", capacity: 1 })
    await service.claimEventSlot(id, MEMBER, slot.id)

    await expect(service.claimEventSlot(id, COHOST, slot.id)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(repo.slotClaims.filter((c) => c.slotId === slot.id)).toHaveLength(1)
  })

  it("a null capacity is unlimited", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Anyone", capacity: null })
    await service.claimEventSlot(id, MEMBER, slot.id)
    await service.claimEventSlot(id, COHOST, slot.id)
    const dto = await service.claimEventSlot(id, ORG, slot.id)
    expect(dto.slots[0]?.claimed).toBe(3)
  })

  it("an idempotent re-claim of a FULL slot the viewer already holds does NOT 409", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill", capacity: 1 })
    await service.claimEventSlot(id, MEMBER, slot.id)

    // The capacity check must be skipped when the current claim IS the target — otherwise a retrying
    // client (or a double tap) gets "That slot is already full" about the slot it is sitting in.
    const again = await service.claimEventSlot(id, MEMBER, slot.id)
    expect(again.slots[0]?.claimed).toBe(1)
    expect(again.slots[0]?.mine).toBe(true)
    expect(repo.slotClaims.filter((c) => c.slotId === slot.id)).toHaveLength(1)
  })

  it("404s an unknown slot id", async () => {
    const id = seedEvent()
    await expect(service.claimEventSlot(id, MEMBER, MISSING)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("404s a slot that belongs to ANOTHER event (the composite FK's app-layer twin)", async () => {
    const id = seedEvent()
    seedEvent(OTHER_CLEANUP_ID)
    const foreign = repo.seedSlot({ cleanupId: OTHER_CLEANUP_ID, title: "Their grill" })

    await expect(service.claimEventSlot(id, MEMBER, foreign.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    expect(repo.slotClaims).toEqual([])
  })

  it("404s a missing cleanup", async () => {
    await expect(service.claimEventSlot(MISSING, MEMBER, MISSING)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })
})

describe("move (A -> B)", () => {
  it("frees A's seat in the same call — never two rows for one person", async () => {
    const id = seedEvent()
    const a = repo.seedSlot({ cleanupId: id, title: "Grill", capacity: 1, sortOrder: 0 })
    const b = repo.seedSlot({ cleanupId: id, title: "Sign-in", capacity: 1, sortOrder: 1 })
    await service.claimEventSlot(id, MEMBER, a.id)

    const dto = await service.claimEventSlot(id, MEMBER, b.id)

    expect(dto.slots.map((s) => [s.title, s.claimed])).toEqual([
      ["Grill", 0],
      ["Sign-in", 1],
    ])
    // The (cleanup_id, user_id) PK is the one-slot-per-person rule: a move is an UPDATE of slot_id.
    expect(repo.slotClaims.filter((c) => c.cleanupId === id && c.userId === MEMBER)).toHaveLength(1)
    // ...and the seat it vacated is immediately claimable by someone else.
    await service.claimEventSlot(id, COHOST, a.id)
    expect(await repo.slotOf(id, COHOST)).toBe(a.id)
  })

  it("a move to a FULL slot 409s and leaves the ORIGINAL claim intact", async () => {
    const id = seedEvent()
    const a = repo.seedSlot({ cleanupId: id, title: "Grill", capacity: 1, sortOrder: 0 })
    const b = repo.seedSlot({ cleanupId: id, title: "Sign-in", capacity: 1, sortOrder: 1 })
    await service.claimEventSlot(id, MEMBER, a.id)
    await service.claimEventSlot(id, COHOST, b.id)

    await expect(service.claimEventSlot(id, MEMBER, b.id)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    // This is exactly what the single-endpoint design buys: a release+claim pair would have dropped the
    // Grill seat first and left this volunteer with nothing.
    expect(await repo.slotOf(id, MEMBER)).toBe(a.id)
  })
})

describe("release", () => {
  it("clears the claim and KEEPS the membership (asymmetric on purpose)", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill" })
    await service.claimEventSlot(id, MEMBER, slot.id)

    const dto = await service.claimEventSlot(id, MEMBER, null)

    expect(dto.slots[0]?.claimed).toBe(0)
    expect(dto.slots[0]?.mine ?? false).toBe(false)
    expect(await repo.slotOf(id, MEMBER)).toBeNull()
    // You keep your RSVP: dropping a shift is not leaving the event.
    expect(dto.joined).toBe(true)
    expect(await repo.isMember(id, MEMBER)).toBe(true)
  })

  it("is idempotent when there is no claim to release", async () => {
    const id = seedEvent()
    repo.seedSlot({ cleanupId: id, title: "Grill" })
    const dto = await service.claimEventSlot(id, MEMBER, null)
    expect(dto.slots[0]?.claimed).toBe(0)
  })

  it("404s a missing cleanup", async () => {
    await expect(service.claimEventSlot(MISSING, MEMBER, null)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })
})

describe("auto-RSVP (B28b)", () => {
  it("claiming inserts the membership row and bumps `going`", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill" })
    const before = await repo.goingCount(id)
    expect(await repo.isMember(id, OUTSIDER)).toBe(false)

    const dto = await service.claimEventSlot(id, OUTSIDER, slot.id)

    // Making a non-member fail with `not_member` and retry would be both worse UX and a worse race.
    expect(await repo.isMember(id, OUTSIDER)).toBe(true)
    expect(dto.going).toBe(before + 1)
    expect(dto.joined).toBe(true)
    expect(dto.myRole).toBe("member")
  })

  it("a FULL slot commits NO membership row (the RSVP follows the seat, not the attempt)", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill", capacity: 1 })
    await service.claimEventSlot(id, MEMBER, slot.id)
    const before = await repo.goingCount(id)

    await expect(service.claimEventSlot(id, OUTSIDER, slot.id)).rejects.toMatchObject({
      code: "CONFLICT",
    })

    // The auto-RSVP is written only once the claim is actually going to be seated. Written earlier it
    // would COMMIT with the refusal (sql.begin commits on a normal return): the caller gets "That slot
    // is already full" and a cache that says not-joined, while the user is silently on the roster,
    // counted in `going`, ringing on every event bell and inside the private event group chat.
    expect(await repo.isMember(id, OUTSIDER)).toBe(false)
    expect(await repo.goingCount(id)).toBe(before)
  })

  it("an unknown slot id commits NO membership row either", async () => {
    const id = seedEvent()
    repo.seedSlot({ cleanupId: id, title: "Grill" })

    await expect(service.claimEventSlot(id, OUTSIDER, MISSING)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })

    expect(await repo.isMember(id, OUTSIDER)).toBe(false)
    expect(repo.slotClaims).toEqual([])
  })

  it("a slot from ANOTHER event commits NO membership row on THIS one", async () => {
    const id = seedEvent()
    seedEvent(OTHER_CLEANUP_ID)
    const foreign = repo.seedSlot({ cleanupId: OTHER_CLEANUP_ID, title: "Their grill" })

    await expect(service.claimEventSlot(id, OUTSIDER, foreign.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })

    // The nastiest shape of the bug: a mistyped or stale slot id would have joined the caller to an
    // event they never RSVP'd to, behind a 404.
    expect(await repo.isMember(id, OUTSIDER)).toBe(false)
    expect(await repo.isMember(OTHER_CLEANUP_ID, OUTSIDER)).toBe(false)
  })

  it("a move to a FULL slot leaves the mover's membership AND original claim intact", async () => {
    const id = seedEvent()
    const a = repo.seedSlot({ cleanupId: id, title: "Grill", capacity: 1, sortOrder: 0 })
    const b = repo.seedSlot({ cleanupId: id, title: "Sign-in", capacity: 1, sortOrder: 1 })
    await service.claimEventSlot(id, OUTSIDER, a.id)
    await service.claimEventSlot(id, COHOST, b.id)

    await expect(service.claimEventSlot(id, OUTSIDER, b.id)).rejects.toMatchObject({
      code: "CONFLICT",
    })

    // Moving the auto-RSVP later must not COST an existing member their membership either.
    expect(await repo.isMember(id, OUTSIDER)).toBe(true)
    expect(await repo.slotOf(id, OUTSIDER)).toBe(a.id)
  })

  it("403s a REMOVED (banned) attendee — the ban probe runs BEFORE the auto-RSVP", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill" })
    await service.removeMember(id, ORG, MEMBER)

    await expect(service.claimEventSlot(id, MEMBER, slot.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    // The slot door is not a way back into an event a host removed you from (M17).
    expect(await repo.isMember(id, MEMBER)).toBe(false)
    expect(repo.slotClaims).toEqual([])
  })
})

describe("closed events (B28e)", () => {
  it("409s a claim on a cancelled event", async () => {
    const id = seedEvent(CLEANUP_ID, { status: "cancelled" })
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill" })

    await expect(service.claimEventSlot(id, OUTSIDER, slot.id)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    // The refusal exists because logEventHours requires CURRENT membership: without it, the
    // auto-RSVP above would be a path to credit for an event you never attended.
    expect(await repo.isMember(id, OUTSIDER)).toBe(false)
    expect(repo.slotClaims).toEqual([])
  })

  it("409s a release on a cancelled event (the attested roster stops moving both ways)", async () => {
    const id = seedEvent(CLEANUP_ID, { status: "upcoming" })
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill" })
    await service.claimEventSlot(id, MEMBER, slot.id)
    repo.cleanups.get(id)!.status = "cancelled"

    await expect(service.claimEventSlot(id, MEMBER, null)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(await repo.slotOf(id, MEMBER)).toBe(slot.id)
  })

  it("still lets an attendee release their shift after the event has ended (cancelled is the only closed state)", async () => {
    const id = seedEvent(CLEANUP_ID, { status: "upcoming" })
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill" })
    await service.claimEventSlot(id, MEMBER, slot.id)
    repo.cleanups.get(id)!.scheduledAt = new Date(Date.now() - 5 * 60 * 60 * 1000)
    repo.cleanups.get(id)!.endsAt = new Date(Date.now() - 4 * 60 * 60 * 1000)

    await service.claimEventSlot(id, MEMBER, null)
    expect(await repo.slotOf(id, MEMBER)).toBeNull()
  })

  it("409s a claim on an event that has already ended (the slot door auto-RSVPs)", async () => {
    const id = seedEvent()
    repo.cleanups.get(id)!.scheduledAt = new Date(Date.now() - 5 * 60 * 60 * 1000)
    repo.cleanups.get(id)!.endsAt = new Date(Date.now() - 4 * 60 * 60 * 1000)
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill" })

    await expect(service.claimEventSlot(id, OUTSIDER, slot.id)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This event has already ended.",
    })
    expect(await repo.isMember(id, OUTSIDER)).toBe(false)
    expect(repo.slotClaims).toEqual([])
  })

  it("lets an attendee claim a shift whose WINDOW has passed while the event runs (D22)", async () => {
    const id = seedEvent()
    const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000)
    repo.cleanups.get(id)!.scheduledAt = startedAt
    repo.cleanups.get(id)!.endsAt = new Date(Date.now() + 2 * 60 * 60 * 1000)
    const slot = repo.seedSlot({
      cleanupId: id,
      title: "Morning sweep",
      startsAt: startedAt,
      endsAt: new Date(startedAt.getTime() + 60 * 60 * 1000),
    })

    const dto = await service.claimEventSlot(id, OUTSIDER, slot.id)
    expect(dto.slots.map((s) => [s.title, s.mine ?? false, s.claimed])).toEqual([
      ["Morning sweep", true, 1],
    ])
    expect(dto.slots[0]?.startsAt).toBe(startedAt.toISOString())
    expect(dto.slots[0]?.endsAt).toBe(new Date(startedAt.getTime() + 60 * 60 * 1000).toISOString())
  })

  it("409s that same past-window shift once the EVENT has ended", async () => {
    const id = seedEvent()
    const startedAt = new Date(Date.now() - 5 * 60 * 60 * 1000)
    repo.cleanups.get(id)!.scheduledAt = startedAt
    repo.cleanups.get(id)!.endsAt = new Date(Date.now() - 4 * 60 * 60 * 1000)
    const slot = repo.seedSlot({
      cleanupId: id,
      title: "Morning sweep",
      startsAt: startedAt,
      endsAt: new Date(startedAt.getTime() + 60 * 60 * 1000),
    })

    await expect(service.claimEventSlot(id, OUTSIDER, slot.id)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This event has already ended.",
    })
    expect(repo.slotClaims).toEqual([])
  })

  it("still releases a slot after the event has ended", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill" })
    await service.claimEventSlot(id, MEMBER, slot.id)
    repo.cleanups.get(id)!.scheduledAt = new Date(Date.now() - 5 * 60 * 60 * 1000)
    repo.cleanups.get(id)!.endsAt = new Date(Date.now() - 4 * 60 * 60 * 1000)

    await service.claimEventSlot(id, MEMBER, null)
    expect(await repo.slotOf(id, MEMBER)).toBeNull()
  })
})

describe("leaving and removal free the seat (B28d)", () => {
  it("leaveCleanup deletes the claim", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill", capacity: 1 })
    await service.claimEventSlot(id, MEMBER, slot.id)

    await service.leaveCleanup(id, MEMBER)

    // Without this the departed attendee holds a phantom-full seat nobody can free.
    expect(await repo.slotOf(id, MEMBER)).toBeNull()
    const board = await repo.listSlots(id, null)
    expect(board[0]?.claimed).toBe(0)
    // ...and the freed seat really is claimable again.
    await service.claimEventSlot(id, COHOST, slot.id)
    expect(await repo.slotOf(id, COHOST)).toBe(slot.id)
  })

  it("removeMember deletes the claim in the same operation as the ban", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill", capacity: 1 })
    await service.claimEventSlot(id, MEMBER, slot.id)

    await service.removeMember(id, ORG, MEMBER)

    expect(await repo.slotOf(id, MEMBER)).toBeNull()
    expect((await repo.listSlots(id, null))[0]?.claimed).toBe(0)
  })
})

describe("the flip budget (B29c)", () => {
  it("429s after SLOT_FLIPS_PER_EVENT_PER_WINDOW flips by the same person on the same event", async () => {
    const id = seedEvent()
    const a = repo.seedSlot({ cleanupId: id, title: "Grill", sortOrder: 0 })
    const b = repo.seedSlot({ cleanupId: id, title: "Sign-in", sortOrder: 1 })
    const limited = makeCleanupService({ tickets: TEST_TICKET_SIGNER, repo, counters })

    for (let i = 0; i < SLOT_FLIPS_PER_EVENT_PER_WINDOW; i++) {
      await limited.claimEventSlot(id, MEMBER, i % 2 === 0 ? a.id : b.id)
    }
    await expect(limited.claimEventSlot(id, MEMBER, a.id)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
  })

  it("is counted per (event, user): another person on the same event is unaffected", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Anyone" })
    const limited = makeCleanupService({ tickets: TEST_TICKET_SIGNER, repo, counters })

    for (let i = 0; i < SLOT_FLIPS_PER_EVENT_PER_WINDOW; i++) {
      await limited.claimEventSlot(id, MEMBER, slot.id)
    }
    await expect(limited.claimEventSlot(id, MEMBER, slot.id)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
    // The budget follows the flapper, not the event.
    const ok = await limited.claimEventSlot(id, COHOST, slot.id)
    expect(ok.slots[0]?.claimed).toBe(2)
  })

  it("charges a REFUSED attempt too (probing for a free seat is not free)", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill", capacity: 1 })
    await service.claimEventSlot(id, COHOST, slot.id)
    const limited = makeCleanupService({ tickets: TEST_TICKET_SIGNER, repo, counters })

    for (let i = 0; i < SLOT_FLIPS_PER_EVENT_PER_WINDOW; i++) {
      await expect(limited.claimEventSlot(id, MEMBER, slot.id)).rejects.toMatchObject({
        code: "CONFLICT",
      })
    }
    // The point of the budget is to keep a flapper off a contended row's lock, so a 409 must still
    // consume allowance — otherwise polling a full slot is unlimited.
    await expect(limited.claimEventSlot(id, MEMBER, slot.id)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
  })
})
