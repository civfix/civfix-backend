
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import type { CleanupRepository, DesiredSlot } from "../../src/services/cleanup-repository.types.js"

const pg = await withPg()

describe.skipIf(!pg)("signup slots (integration)", () => {
  let h: PgHarness
  let repo: CleanupRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleCleanupRepository(h.sql)
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  const FUTURE = new Date(Date.now() + 7 * 86_400_000)

  async function newCleanup(
    organizerId: string,
    over: { status?: string } = {},
  ): Promise<string> {
    const id = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${id}, ${organizerId}, 'site', 'Slot sweep',
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
        ${FUTURE}, ${over.status ?? "upcoming"}
      )
    `
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role)
      VALUES (${id}, ${organizerId}, 'organizer')
      ON CONFLICT DO NOTHING
    `
    return id
  }

  async function newSlot(
    cleanupId: string,
    over: { title?: string; capacity?: number | null; sortOrder?: number } = {},
  ): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_slots (cleanup_id, title, description, capacity, sort_order)
      VALUES (
        ${cleanupId}, ${over.title ?? "Grill"}, NULL,
        ${over.capacity === undefined ? null : over.capacity}, ${over.sortOrder ?? 0}
      )
      RETURNING id
    `
    return row!.id
  }

  async function claimCount(slotId: string): Promise<number> {
    const rows = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_slot_claims WHERE slot_id = ${slotId}
    `
    return rows[0]!.n
  }

  async function membershipCount(cleanupId: string, userId: string): Promise<number> {
    const rows = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_members
      WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
    `
    return rows[0]!.n
  }

  async function titlesOf(cleanupId: string): Promise<[string, string][]> {
    const board = await repo.listSlots(cleanupId, null)
    return board.map((s) => [s.id, s.title])
  }

  function slot(over: Partial<DesiredSlot> = {}): DesiredSlot {
    return {
      title: over.title ?? "Grill",
      description: over.description ?? null,
      capacity: over.capacity ?? null,
      sortOrder: over.sortOrder ?? 0,
      ...(over.id !== undefined ? { id: over.id } : {}),
    }
  }

  it("N CONCURRENT claims on a capacity-1 slot: exactly ONE winner", async () => {
    const org = await newUser("Race Host")
    const cleanupId = await newCleanup(org)
    const slotId = await newSlot(cleanupId, { capacity: 1 })
    const racers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => newUser(`Racer ${i}`)),
    )

    const outcomes = await Promise.all(
      racers.map((userId) => repo.claimSlot(cleanupId, userId, slotId)),
    )

    expect(outcomes.filter((o) => o.kind === "claimed")).toHaveLength(1)
    expect(outcomes.filter((o) => o.kind === "full")).toHaveLength(racers.length - 1)
    expect(await claimCount(slotId)).toBe(1)
  })

  it("concurrent claims on a capacity-3 slot fill it exactly, never past it", async () => {
    const org = await newUser("Capacity Host")
    const cleanupId = await newCleanup(org)
    const slotId = await newSlot(cleanupId, { capacity: 3 })
    const racers = await Promise.all(
      Array.from({ length: 10 }, (_, i) => newUser(`Cap racer ${i}`)),
    )

    const outcomes = await Promise.all(
      racers.map((userId) => repo.claimSlot(cleanupId, userId, slotId)),
    )

    expect(outcomes.filter((o) => o.kind === "claimed")).toHaveLength(3)
    expect(outcomes.filter((o) => o.kind === "full")).toHaveLength(7)
    expect(await claimCount(slotId)).toBe(3)
  })

  it("moving A -> B frees A's seat and never leaves two rows for one person", async () => {
    const org = await newUser("Move Host")
    const cleanupId = await newCleanup(org)
    const a = await newSlot(cleanupId, { title: "Grill", capacity: 1, sortOrder: 0 })
    const b = await newSlot(cleanupId, { title: "Sign-in", capacity: 1, sortOrder: 1 })
    const user = await newUser("Mover")
    const nextInLine = await newUser("Next in line")

    expect(await repo.claimSlot(cleanupId, user, a)).toEqual({ kind: "claimed", slotId: a })
    expect(await repo.claimSlot(cleanupId, user, b)).toEqual({ kind: "claimed", slotId: b })

    expect(await claimCount(a)).toBe(0)
    expect(await claimCount(b)).toBe(1)
    expect(await repo.claimSlot(cleanupId, nextInLine, a)).toEqual({ kind: "claimed", slotId: a })
    expect(await repo.slotOf(cleanupId, user)).toBe(b)
  })

  it("the (cleanup_id, user_id) PK rejects a SECOND row for the same person", async () => {
    const org = await newUser("PK Host")
    const cleanupId = await newCleanup(org)
    const a = await newSlot(cleanupId, { title: "Grill", sortOrder: 0 })
    const b = await newSlot(cleanupId, { title: "Sign-in", sortOrder: 1 })
    const user = await newUser("PK User")
    await repo.claimSlot(cleanupId, user, a)

    await expect(
      h.sql`
        INSERT INTO cleanup_slot_claims (cleanup_id, user_id, slot_id)
        VALUES (${cleanupId}, ${user}, ${b})
      `,
    ).rejects.toMatchObject({ code: "23505" })
    expect(await repo.slotOf(cleanupId, user)).toBe(a)
  })

  it("the composite FK rejects a slotId from ANOTHER cleanup", async () => {
    const org = await newUser("FK Host")
    const mine = await newCleanup(org)
    const theirs = await newCleanup(await newUser("Other Host"))
    const foreignSlot = await newSlot(theirs, { title: "Their grill" })
    const user = await newUser("FK User")

    expect(await repo.claimSlot(mine, user, foreignSlot)).toEqual({ kind: "slot_not_found" })
    await expect(
      h.sql`
        INSERT INTO cleanup_slot_claims (cleanup_id, user_id, slot_id)
        VALUES (${mine}, ${user}, ${foreignSlot})
      `,
    ).rejects.toMatchObject({ code: "23503" })
  })

  it("the lower(title) unique index rejects a duplicate title on the same event", async () => {
    const org = await newUser("Title Host")
    const cleanupId = await newCleanup(org)
    await newSlot(cleanupId, { title: "Grill" })

    await expect(newSlot(cleanupId, { title: "GRILL" })).rejects.toMatchObject({ code: "23505" })
    const other = await newCleanup(org)
    await expect(newSlot(other, { title: "Grill" })).resolves.toBeTypeOf("string")
  })

  it("deleting a slot cascades its claims; deleting the cleanup cascades both", async () => {
    const org = await newUser("Cascade Host")
    const cleanupId = await newCleanup(org)
    const doomed = await newSlot(cleanupId, { title: "Doomed", sortOrder: 0 })
    const survivor = await newSlot(cleanupId, { title: "Survivor", sortOrder: 1 })
    const u1 = await newUser("Cascade A")
    const u2 = await newUser("Cascade B")
    await repo.claimSlot(cleanupId, u1, doomed)
    await repo.claimSlot(cleanupId, u2, survivor)

    await h.sql`DELETE FROM cleanup_slots WHERE id = ${doomed}`
    expect(await claimCount(doomed)).toBe(0)
    expect(await claimCount(survivor)).toBe(1)

    await h.sql`DELETE FROM cleanups WHERE id = ${cleanupId}`
    const slotsLeft = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_slots WHERE cleanup_id = ${cleanupId}
    `
    const claimsLeft = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_slot_claims WHERE cleanup_id = ${cleanupId}
    `
    expect(slotsLeft[0]!.n).toBe(0)
    expect(claimsLeft[0]!.n).toBe(0)
  })

  it("leaveCleanup frees the seat (B28d)", async () => {
    const org = await newUser("Leave Host")
    const cleanupId = await newCleanup(org)
    const slotId = await newSlot(cleanupId, { capacity: 1 })
    const leaver = await newUser("Leaver")
    const nextInLine = await newUser("Waiting")
    await repo.claimSlot(cleanupId, leaver, slotId)

    await repo.leaveCleanup(cleanupId, leaver)

    expect(await claimCount(slotId)).toBe(0)
    expect(await repo.slotOf(cleanupId, leaver)).toBeNull()
    expect(await repo.claimSlot(cleanupId, nextInLine, slotId)).toEqual({
      kind: "claimed",
      slotId,
    })
  })

  it("removeMember frees the seat in the SAME transaction as the ban (B28d)", async () => {
    const org = await newUser("Remove Host")
    const cleanupId = await newCleanup(org)
    const slotId = await newSlot(cleanupId, { capacity: 1 })
    const target = await newUser("Removed")
    await repo.claimSlot(cleanupId, target, slotId)

    const outcome = await repo.removeMember(cleanupId, target, org)

    expect(outcome.kind).toBe("removed")
    expect(await claimCount(slotId)).toBe(0)
    expect(await repo.claimSlot(cleanupId, target, slotId)).toEqual({ kind: "banned" })
  })

  it("claiming auto-RSVPs, and is refused on a done or cancelled event", async () => {
    const org = await newUser("Closed Host")
    const open = await newCleanup(org)
    const openSlot = await newSlot(open)
    const joiner = await newUser("Auto RSVP")

    expect(await repo.isMember(open, joiner)).toBe(false)
    await repo.claimSlot(open, joiner, openSlot)
    expect(await repo.isMember(open, joiner)).toBe(true)
    expect(await repo.roleOf(open, joiner)).toBe("member")

    for (const status of ["done", "cancelled"]) {
      const closed = await newCleanup(org, { status })
      const closedSlot = await newSlot(closed)
      const latecomer = await newUser(`Late ${status}`)
      expect(await repo.claimSlot(closed, latecomer, closedSlot)).toEqual({ kind: "closed" })
      expect(await repo.isMember(closed, latecomer)).toBe(false)
      expect(await repo.releaseSlot(closed, latecomer)).toEqual({ kind: "closed" })
    }
  })

  it("an idempotent re-claim of a FULL slot the caller already holds still succeeds", async () => {
    const org = await newUser("Idempotent Host")
    const cleanupId = await newCleanup(org)
    const slotId = await newSlot(cleanupId, { capacity: 1 })
    const user = await newUser("Holder")
    await repo.claimSlot(cleanupId, user, slotId)

    expect(await repo.claimSlot(cleanupId, user, slotId)).toEqual({ kind: "claimed", slotId })
    expect(await claimCount(slotId)).toBe(1)
  })

  it("release is idempotent and keeps the membership", async () => {
    const org = await newUser("Release Host")
    const cleanupId = await newCleanup(org)
    const slotId = await newSlot(cleanupId)
    const user = await newUser("Releaser")
    await repo.claimSlot(cleanupId, user, slotId)

    expect(await repo.releaseSlot(cleanupId, user)).toEqual({ kind: "released" })
    expect(await repo.releaseSlot(cleanupId, user)).toEqual({ kind: "released" })
    expect(await claimCount(slotId)).toBe(0)
    expect(await repo.isMember(cleanupId, user)).toBe(true)
  })

  it("createCleanupTx inserts the slots in the SAME transaction as the event", async () => {
    const org = await newUser("Create Host")
    const cleanupId = randomUUID()
    const record = await repo.createCleanupTx({
      cleanupId,
      organizerUserId: org,
      type: "site",
      eventKind: "cleanup",
      title: "Created with slots",
      description: null,
      lat: 34.05,
      lng: -118.25,
      scheduledAt: FUTURE,
      status: "upcoming",
      bring: null,
      address: null,
      jurisdictionGeoid: null,
      jurCode: 0,
      linkedReportIds: [],
      slots: [slot({ title: "Grill", capacity: 2, sortOrder: 0 }), slot({ title: "Sign-in", sortOrder: 1 })],
      host: {},
    })

    expect(record.record.id).toBe(cleanupId)
    const board = await repo.listSlots(cleanupId, org)
    expect(board.map((s) => [s.title, s.capacity, s.sortOrder, s.claimed, s.mine])).toEqual([
      ["Grill", 2, 0, 0, false],
      ["Sign-in", null, 1, 0, false],
    ])
  })

  it("reconcileSlots adds, updates, deletes and reports the dropped claimants", async () => {
    const org = await newUser("Reconcile Host")
    const cleanupId = await newCleanup(org)
    const keep = await newSlot(cleanupId, { title: "Grill", capacity: 2, sortOrder: 0 })
    const drop = await newSlot(cleanupId, { title: "Cleanup crew", sortOrder: 1 })
    const claimant = await newUser("Dropped claimant")
    await repo.claimSlot(cleanupId, claimant, drop)
    await repo.claimSlot(cleanupId, org, drop)

    const result = await repo.reconcileSlots(
      cleanupId,
      [slot({ id: keep, title: "Grill duty", capacity: 4 }), slot({ title: "Sign-in", sortOrder: 2 })],
      org,
    )

    expect(result.updated).toEqual([keep])
    expect(result.added).toHaveLength(1)
    expect(result.removed).toEqual([
      { slotId: drop, title: "Cleanup crew", claimantUserIds: [claimant] },
    ])
    const board = await repo.listSlots(cleanupId, null)
    expect(board.map((s) => s.title).sort()).toEqual(["Grill duty", "Sign-in"])
    expect(await repo.slotOf(cleanupId, claimant)).toBeNull()
  })

  it("reconcileSlots 422s a foreign id and rolls the WHOLE transaction back", async () => {
    const org = await newUser("Foreign Host")
    const mine = await newCleanup(org)
    const theirs = await newCleanup(await newUser("Foreign Other"))
    const mySlot = await newSlot(mine, { title: "Mine" })
    const foreign = await newSlot(theirs, { title: "Theirs" })

    await expect(
      repo.reconcileSlots(
        mine,
        [slot({ title: "Brand new" }), slot({ id: foreign, title: "Stolen" })],
        org,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" })

    const board = await repo.listSlots(mine, null)
    expect(board.map((s) => s.id)).toEqual([mySlot])
    const foreignRow = await h.sql<{ cleanup_id: string; title: string }[]>`
      SELECT cleanup_id, title FROM cleanup_slots WHERE id = ${foreign}
    `
    expect(foreignRow[0]).toEqual({ cleanup_id: theirs, title: "Theirs" })
  })


  it("reconcileSlots SWAPS two slot titles in one save", async () => {
    const org = await newUser("Swap Host")
    const cleanupId = await newCleanup(org)
    const reg = await newSlot(cleanupId, { title: "Registration", sortOrder: 0 })
    const grill = await newSlot(cleanupId, { title: "Grill", sortOrder: 1 })

    const result = await repo.reconcileSlots(
      cleanupId,
      [
        slot({ id: reg, title: "Grill", sortOrder: 0 }),
        slot({ id: grill, title: "Registration", sortOrder: 1 }),
      ],
      org,
    )

    expect(result.updated.sort()).toEqual([reg, grill].sort())
    expect(result.removed).toEqual([])
    expect(await titlesOf(cleanupId)).toEqual([
      [reg, "Grill"],
      [grill, "Registration"],
    ])
  })

  it("reconcileSlots REMOVES a slot and re-adds the SAME title in one save", async () => {
    const org = await newUser("Readd Host")
    const cleanupId = await newCleanup(org)
    const old = await newSlot(cleanupId, { title: "Grill" })
    const claimant = await newUser("Readd claimant")
    await repo.claimSlot(cleanupId, claimant, old)

    const result = await repo.reconcileSlots(
      cleanupId,
      [slot({ title: "Grill", capacity: 5 })],
      org,
    )

    expect(result.added).toHaveLength(1)
    expect(result.removed).toEqual([
      { slotId: old, title: "Grill", claimantUserIds: [claimant] },
    ])
    const board = await repo.listSlots(cleanupId, null)
    expect(board.map((s) => [s.title, s.capacity])).toEqual([["Grill", 5]])
    expect(board[0]!.id).not.toBe(old)
    expect(await repo.slotOf(cleanupId, claimant)).toBeNull()
  })

  it("reconcileSlots RENAMES a kept slot onto the title of a slot it is removing", async () => {
    const org = await newUser("Rename Host")
    const cleanupId = await newCleanup(org)
    const keep = await newSlot(cleanupId, { title: "Grill", sortOrder: 0 })
    const drop = await newSlot(cleanupId, { title: "Registration", sortOrder: 1 })

    const result = await repo.reconcileSlots(
      cleanupId,
      [slot({ id: keep, title: "Registration", sortOrder: 0 })],
      org,
    )

    expect(result.removed.map((r) => r.slotId)).toEqual([drop])
    expect(await titlesOf(cleanupId)).toEqual([[keep, "Registration"]])
  })

  it("a duplicate title inside the desired set is a NAMED 422, never a leaked 23505", async () => {
    const org = await newUser("Dup Host")
    const cleanupId = await newCleanup(org)
    const existing = await newSlot(cleanupId, { title: "Grill" })

    await expect(
      repo.reconcileSlots(
        cleanupId,
        [slot({ title: "Grill", sortOrder: 0 }), slot({ title: "GRILL", sortOrder: 1 })],
        org,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", fields: { slots: "duplicate slot title" } })
    expect(await titlesOf(cleanupId)).toEqual([[existing, "Grill"]])
  })


  it("a `slot_not_found` claim commits NO cleanup_members row", async () => {
    const org = await newUser("No-RSVP Host")
    const cleanupId = await newCleanup(org)
    await newSlot(cleanupId, { title: "Grill" })
    const stranger = await newUser("Stranger")

    expect(await repo.claimSlot(cleanupId, stranger, randomUUID())).toEqual({
      kind: "slot_not_found",
    })

    expect(await membershipCount(cleanupId, stranger)).toBe(0)
    expect(await repo.isMember(cleanupId, stranger)).toBe(false)
  })

  it("a `full` claim commits NO cleanup_members row", async () => {
    const org = await newUser("Full Host")
    const cleanupId = await newCleanup(org)
    const slotId = await newSlot(cleanupId, { title: "Grill", capacity: 1 })
    const winner = await newUser("Seat winner")
    const loser = await newUser("Seat loser")
    await repo.claimSlot(cleanupId, winner, slotId)
    const going = await repo.goingCount(cleanupId)

    expect(await repo.claimSlot(cleanupId, loser, slotId)).toEqual({ kind: "full" })

    expect(await membershipCount(cleanupId, loser)).toBe(0)
    expect(await repo.goingCount(cleanupId)).toBe(going)
    expect(await repo.isMember(cleanupId, winner)).toBe(true)
  })

  it("a foreign slot id commits NO cleanup_members row on EITHER event", async () => {
    const org = await newUser("Foreign RSVP Host")
    const mine = await newCleanup(org)
    const theirs = await newCleanup(await newUser("Foreign RSVP Other"))
    const foreignSlot = await newSlot(theirs, { title: "Their grill" })
    const stranger = await newUser("Foreign RSVP Stranger")

    expect(await repo.claimSlot(mine, stranger, foreignSlot)).toEqual({ kind: "slot_not_found" })

    expect(await membershipCount(mine, stranger)).toBe(0)
    expect(await membershipCount(theirs, stranger)).toBe(0)
  })

  it("a MOVE refused as `full` keeps the mover's membership and original seat", async () => {
    const org = await newUser("Move Full Host")
    const cleanupId = await newCleanup(org)
    const a = await newSlot(cleanupId, { title: "Grill", capacity: 1, sortOrder: 0 })
    const b = await newSlot(cleanupId, { title: "Sign-in", capacity: 1, sortOrder: 1 })
    const mover = await newUser("Blocked mover")
    const holder = await newUser("Seat holder")
    await repo.claimSlot(cleanupId, mover, a)
    await repo.claimSlot(cleanupId, holder, b)

    expect(await repo.claimSlot(cleanupId, mover, b)).toEqual({ kind: "full" })

    expect(await membershipCount(cleanupId, mover)).toBe(1)
    expect(await repo.slotOf(cleanupId, mover)).toBe(a)
  })

  it("listAttendees carries each attendee's slot, and slotCountsFor batches the list read", async () => {
    const org = await newUser("Roster Host")
    const cleanupId = await newCleanup(org)
    const grill = await newSlot(cleanupId, { title: "Grill", sortOrder: 0 })
    await newSlot(cleanupId, { title: "Sign-in", sortOrder: 1 })
    const attendee = await newUser("Grill cook")
    await repo.claimSlot(cleanupId, attendee, grill)

    const roster = await repo.listAttendees({
      cleanupId,
      viewerId: org,
      onlyFollowed: false,
      limit: 50,
    })
    const rows = roster.map((a) => [a.id, a.slot?.title ?? null])
    expect(rows).toContainEqual([attendee, "Grill"])
    expect(rows).toContainEqual([org, null])

    const empty = await newCleanup(org)
    const counts = await repo.slotCountsFor([cleanupId, empty])
    expect(counts.get(cleanupId)).toBe(2)
    expect(counts.get(empty)).toBeUndefined()
    expect(await repo.slotCountsFor([])).toEqual(new Map())
  })

  it("the hydration read reports `mine` per viewer and claimed counts globally", async () => {
    const org = await newUser("Hydrate Host")
    const cleanupId = await newCleanup(org)
    const grill = await newSlot(cleanupId, { title: "Grill", capacity: 4, sortOrder: 0 })
    await newSlot(cleanupId, { title: "Sign-in", sortOrder: 1 })
    const a = await newUser("Hydrate A")
    const b = await newUser("Hydrate B")
    await repo.claimSlot(cleanupId, a, grill)
    await repo.claimSlot(cleanupId, b, grill)

    const asA = await repo.listSlots(cleanupId, a)
    expect(asA.map((s) => [s.title, s.claimed, s.mine])).toEqual([
      ["Grill", 2, true],
      ["Sign-in", 0, false],
    ])
    const anon = await repo.listSlots(cleanupId, null)
    expect(anon.map((s) => [s.claimed, s.mine])).toEqual([
      [2, false],
      [0, false],
    ])
    const grouped = await repo.loadSlotsForCleanups([cleanupId], a)
    expect(grouped.get(cleanupId)).toHaveLength(2)
    expect(await repo.loadSlotsForCleanups([], a)).toEqual(new Map())
  })

  it("capacity lowered below the live claim count evicts nobody and then refuses new claims", async () => {
    const org = await newUser("Shrink Host")
    const cleanupId = await newCleanup(org)
    const slotId = await newSlot(cleanupId, { title: "Grill", capacity: 3 })
    const claimants = await Promise.all(
      Array.from({ length: 3 }, (_, i) => newUser(`Shrink ${i}`)),
    )
    for (const u of claimants) await repo.claimSlot(cleanupId, u, slotId)

    await repo.reconcileSlots(cleanupId, [slot({ id: slotId, title: "Grill", capacity: 1 })], org)

    expect(await claimCount(slotId)).toBe(3)
    const latecomer = await newUser("Shrink latecomer")
    expect(await repo.claimSlot(cleanupId, latecomer, slotId)).toEqual({ kind: "full" })
  })

  it("the capacity CHECK constraint refuses a zero or negative capacity", async () => {
    const org = await newUser("Check Host")
    const cleanupId = await newCleanup(org)
    await expect(newSlot(cleanupId, { title: "Zero", capacity: 0 })).rejects.toMatchObject({
      code: "23514",
    })
  })

  it("claimSlot on a missing cleanup or a missing slot reports which one", async () => {
    const org = await newUser("Missing Host")
    const cleanupId = await newCleanup(org)
    const user = await newUser("Missing User")
    expect(await repo.claimSlot(randomUUID(), user, randomUUID())).toEqual({ kind: "not_found" })
    expect(await repo.claimSlot(cleanupId, user, randomUUID())).toEqual({ kind: "slot_not_found" })
    expect(await repo.releaseSlot(randomUUID(), user)).toEqual({ kind: "not_found" })
  })
})
