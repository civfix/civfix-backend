/**
 * P9 signup slots against a live PostGIS container (Docker-gated).
 *
 * This is the file that matters. Everything the unit suites assert runs against a single-threaded fake
 * that serializes by construction — so the ONE property that actually keeps two volunteers from taking
 * the same last seat, the `FOR UPDATE` on the slot row, is invisible there by definition. The same goes
 * for every constraint the schema (rather than the application) enforces:
 *
 *   - N CONCURRENT claims on a capacity-1 slot yield EXACTLY ONE winner, N−1 `full`, and exactly one
 *     row in cleanup_slot_claims (real parallel transactions on separate pooled connections);
 *   - moving A -> B frees A's seat in the same statement;
 *   - the (cleanup_id, user_id) PK makes a second slot for the same person impossible;
 *   - the composite FK (slot_id, cleanup_id) rejects a slotId from ANOTHER cleanup;
 *   - the lower(title) unique index rejects a duplicate title (the backstop behind the service's
 *     deterministic 422) — and, because that index is checked IMMEDIATELY rather than at commit, that a
 *     reconcile which swaps two titles, re-adds a removed title, or renames a kept slot onto a removed
 *     one still succeeds (the twin holds no index, so it cannot fail any of these);
 *   - a REFUSED claim (`slot_not_found`, `full`) commits no cleanup_members row — sql.begin commits on
 *     a normal return, and every refusal here is a normal return;
 *   - deleting a slot cascades its claims, and deleting the cleanup cascades both;
 *   - leaveCleanup and removeMember free the seat (B28d) in their existing transactions.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI (and
 * CIVFIX_REQUIRE_PG=1) turns that skip into a hard failure.
 */

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

  /** Insert a cleanup (+ the organizer's membership) and return its id. */
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

  /** Membership rows for one person on one event — 0 or 1, straight from the table. */
  async function membershipCount(cleanupId: string, userId: string): Promise<number> {
    const rows = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_members
      WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
    `
    return rows[0]!.n
  }

  /** The board as (id, title) pairs in board order — the shape every reconcile assertion needs. */
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

    // Every call opens its OWN sql.begin on its own pooled connection, so this is a genuine race. The
    // FOR UPDATE on the slot row is what serializes them: the loser blocks on the lock and its
    // subsequent count(*) sees the winner's committed row. WITHOUT that lock every racer's count would
    // read 0 and all 8 would insert.
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
    // The freed seat is immediately real, not merely logically vacated.
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

    // A raw INSERT (not the repo's ON CONFLICT DO UPDATE) is what proves the SCHEMA carries the
    // one-slot-per-person rule, rather than the application merely being careful.
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

    // The repo's own predicate answers first...
    expect(await repo.claimSlot(mine, user, foreignSlot)).toEqual({ kind: "slot_not_found" })
    // ...and even if that predicate were ever dropped, the FK makes the write structurally impossible.
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

    // The service refuses this deterministically (a named 422); this index is the backstop for a direct
    // or racing write, and asserting it here is what makes the service check a convenience rather than
    // the only line of defense.
    await expect(newSlot(cleanupId, { title: "GRILL" })).rejects.toMatchObject({ code: "23505" })
    // ...but the SAME title on a DIFFERENT event is fine (the index is per-cleanup).
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

    // Without the claim delete this seat stays occupied forever by someone who is not even on the
    // roster — a phantom-full slot no host can attribute and no attendee can free.
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
    // ...and the ban keeps them from walking back in through the slot door.
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
      // The auto-RSVP must not have fired either — that is the credit-laundering path B28e closes.
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
    })

    expect(record.id).toBe(cleanupId)
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
    // The ACTOR's own claim must be excluded from the bell list — a host does not ring themselves.
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
    // The dropped slot's claims went with it (ON DELETE CASCADE on the composite FK).
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

    // All-or-nothing: the legal "Brand new" entry did NOT land, and the foreign row was not re-parented.
    const board = await repo.listSlots(mine, null)
    expect(board.map((s) => s.id)).toEqual([mySlot])
    const foreignRow = await h.sql<{ cleanup_id: string; title: string }[]>`
      SELECT cleanup_id, title FROM cleanup_slots WHERE id = ${foreign}
    `
    expect(foreignRow[0]).toEqual({ cleanup_id: theirs, title: "Theirs" })
  })

  // ---------------------------------------------------------------------------------------------
  // The reconcile WRITE ORDER (cleanup_slots_cleanup_title_uidx is checked IMMEDIATELY).
  //
  // Postgres has no deferrable unique INDEX — only a deferrable unique CONSTRAINT — and 0063 declares
  // an index, so every intermediate state inside the reconcile transaction has to satisfy
  // (cleanup_id, lower(title)) on its own. These three saves are the ordinary host edits that a naive
  // "update and insert, then delete" order breaks with a raw 23505 → 500, and none of them can be seen
  // against the in-memory twin, which holds no index at all. They are exactly the cases that were
  // reproduced against a live container before the write order was changed.
  // ---------------------------------------------------------------------------------------------

  it("reconcileSlots SWAPS two slot titles in one save", async () => {
    const org = await newUser("Swap Host")
    const cleanupId = await newCleanup(org)
    const reg = await newSlot(cleanupId, { title: "Registration", sortOrder: 0 })
    const grill = await newSlot(cleanupId, { title: "Grill", sortOrder: 1 })

    // Naively this is `UPDATE ... SET title='Grill' WHERE id=reg` while `grill` still holds "Grill":
    // duplicate key value violates unique constraint "cleanup_slots_cleanup_title_uidx".
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
    // Both rows keep their IDENTITY through the swap, which is the whole reason slots carry a uuid.
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

    // The insert has to wait for the delete: the old "Grill" row is still there until it lands.
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
    // A genuinely NEW row: dropping the id is how a host resets a slot's claimants, and the dropped
    // claim went with the old row rather than following the title.
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

    // The service refuses this deterministically before the repo is reached; this asserts the repo's
    // own backstop, because a raw driver error reaches the client as an unactionable 500 and the
    // ordering above cannot fix a set that is duplicated in itself.
    await expect(
      repo.reconcileSlots(
        cleanupId,
        [slot({ title: "Grill", sortOrder: 0 }), slot({ title: "GRILL", sortOrder: 1 })],
        org,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", fields: { slots: "duplicate slot title" } })
    // ...and the whole transaction rolled back, so the board is exactly as it was.
    expect(await titlesOf(cleanupId)).toEqual([[existing, "Grill"]])
  })

  // ---------------------------------------------------------------------------------------------
  // The auto-RSVP must not survive a REFUSED claim. sql.begin COMMITS on a normal return and every
  // refusal below is a normal return, so a membership insert written before the slot lookup commits
  // with the 404/409 — the caller sees an error while the user is silently on the roster, counted in
  // `going`, and inside the private event group chat (cleanup_members.role is the chat gate).
  // ---------------------------------------------------------------------------------------------

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
    const going = await repo.memberCount(cleanupId)

    expect(await repo.claimSlot(cleanupId, loser, slotId)).toEqual({ kind: "full" })

    expect(await membershipCount(cleanupId, loser)).toBe(0)
    expect(await repo.memberCount(cleanupId)).toBe(going)
    // The winner's own auto-RSVP still happened — the fix is about WHICH outcomes write it.
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

    // Deferring the auto-RSVP must not COST an existing member their membership either.
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
    // The organizer RSVP'd without a slot: an explicit null, not a missing key.
    expect(rows).toContainEqual([org, null])

    const empty = await newCleanup(org)
    const counts = await repo.slotCountsFor([cleanupId, empty])
    expect(counts.get(cleanupId)).toBe(2)
    // An event with no slots has no row in the aggregate at all — the caller defaults it to 0.
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
    // Anonymous: same public counts, `mine` false everywhere (the NULL comparison, not a special case).
    const anon = await repo.listSlots(cleanupId, null)
    expect(anon.map((s) => [s.claimed, s.mine])).toEqual([
      [2, false],
      [0, false],
    ])
    // The batched form groups by cleanup id and skips a page with nothing in it.
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

    // There is no fair rule for choosing who loses their shift, so nobody does — the slot is simply
    // over-subscribed until it drains, and the DTO renders "3/1" honestly.
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
