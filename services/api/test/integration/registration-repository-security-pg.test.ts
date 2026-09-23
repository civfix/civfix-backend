import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleHostRegistrationRepository } from "../../src/services/host/registration-repository.drizzle.js"
import { makeTicketTokenSigner } from "../../src/services/host/ticket-token.js"
import type {
  HostRegistrationRepository,
  RegisterTxArgs,
  SeatDraft,
} from "../../src/services/host/registration-repository.types.js"

const pg = await withPg()
const tokens = makeTicketTokenSigner("integration-registration-security-secret")
const FUTURE = new Date(Date.now() + 7 * 86_400_000)
const CLAIM_WINDOW_MS = 60 * 60 * 1000

describe.skipIf(!pg)("registration security (integration)", () => {
  let h: PgHarness
  let repo: HostRegistrationRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleHostRegistrationRepository(h.sql)
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return (u as { id: string }).id
  }

  async function newCleanup(): Promise<string> {
    return await seedCleanup(h.sql, {
      organizerUserId: await newUser("Organizer"),
      title: "Registration security",
      lng: -118.25,
      lat: 34.05,
      scheduledAt: FUTURE,
    })
  }

  async function newTicketType(
    cleanupId: string,
    over: { capacity?: number; visibility?: string } = {},
  ): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_ticket_types (
        cleanup_id, name, capacity, max_party_size, waitlist_enabled, visibility
      ) VALUES (
        ${cleanupId}, ${`Type ${randomUUID().slice(0, 8)}`}, ${over.capacity ?? 5}, 4, true,
        ${over.visibility ?? "public"}
      )
      RETURNING id
    `
    return (row as { id: string }).id
  }

  function seats(partySize: number): SeatDraft[] {
    return Array.from({ length: partySize }, () => {
      const id = randomUUID()
      return { id, attendeeName: null, tokenHash: tokens.hashFor(id) }
    })
  }

  function selfRegistration(
    cleanupId: string,
    userId: string,
    ticketTypeId: string | null,
    partySize = 1,
  ): RegisterTxArgs {
    return {
      cleanupId,
      subject: { kind: "user", userId },
      ticketTypeId,
      seats: seats(partySize),
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "self",
      idempotencyKey: `self-${randomUUID()}`,
      waitlistId: null,
      now: new Date(),
    }
  }

  async function reservedSeats(ticketTypeId: string): Promise<number> {
    const rows = await h.sql<{ reserved_seats: number }[]>`
      SELECT reserved_seats FROM cleanup_ticket_types WHERE id = ${ticketTypeId}
    `
    return (rows[0] as { reserved_seats: number }).reserved_seats
  }

  async function waitlistStatuses(userId: string): Promise<string[]> {
    const rows = await h.sql<{ status: string }[]>`
      SELECT status FROM cleanup_waitlist WHERE user_id = ${userId} ORDER BY created_at, id
    `
    return rows.map((r) => r.status)
  }

  it("refuses a self registration on a sole hidden type but seats a host walk-up on it", async () => {
    const cleanupId = await newCleanup()
    const hidden = await newTicketType(cleanupId, { visibility: "hidden" })
    const userId = await newUser("Self")

    await expect(repo.registerTx(selfRegistration(cleanupId, userId, null))).resolves.toEqual({
      kind: "ticket_type_not_found",
    })
    await expect(repo.registerTx(selfRegistration(cleanupId, userId, hidden))).resolves.toEqual({
      kind: "ticket_type_not_found",
    })
    expect(await reservedSeats(hidden)).toBe(0)

    const walkup = await repo.registerWalkupTx({
      cleanupId,
      name: "Walk In",
      manageTokenHash: `walkup-${randomUUID()}`,
      ticketTypeId: hidden,
      seats: seats(1),
      idempotencyKey: `walkup-${randomUUID()}`,
      idempotencyOwner: `user:${userId}`,
      now: new Date(),
    })
    expect(walkup.kind).toBe("registered")
    expect(await reservedSeats(hidden)).toBe(1)
  })

  it("refuses a waitlist join on a hidden type, and a banned user's join", async () => {
    const cleanupId = await newCleanup()
    const hidden = await newTicketType(cleanupId, { visibility: "hidden" })
    const open = await newTicketType(cleanupId)
    const banned = await newUser("Banned")
    await h.sql`INSERT INTO cleanup_bans (cleanup_id, user_id) VALUES (${cleanupId}, ${banned})`

    await expect(
      repo.joinWaitlist({
        cleanupId,
        ticketTypeId: hidden,
        subject: { kind: "user", userId: await newUser("Joiner") },
        partySize: 1,
        accessCodeHash: null,
        now: new Date(),
      }),
    ).resolves.toEqual({ kind: "ticket_type_not_found" })
    await expect(
      repo.joinWaitlist({
        cleanupId,
        ticketTypeId: open,
        subject: { kind: "user", userId: banned },
        partySize: 1,
        accessCodeHash: null,
        now: new Date(),
      }),
    ).resolves.toEqual({ kind: "banned" })
    expect(await waitlistStatuses(banned)).toEqual([])
  })

  it("skips a banned user who is still waiting when offering a place", async () => {
    const cleanupId = await newCleanup()
    const type = await newTicketType(cleanupId, { capacity: 1 })
    const banned = await newUser("Banned waiter")
    const next = await newUser("Next waiter")
    const now = new Date()
    for (const [index, userId] of [banned, next].entries()) {
      await repo.joinWaitlist({
        cleanupId,
        ticketTypeId: type,
        subject: { kind: "user", userId },
        partySize: 1,
        accessCodeHash: null,
        now: new Date(now.getTime() + index * 1000),
      })
    }
    await h.sql`INSERT INTO cleanup_bans (cleanup_id, user_id) VALUES (${cleanupId}, ${banned})`

    const offer = await repo.offerNextWaitlistEntry({
      ticketTypeId: type,
      now,
      claimWindowMs: CLAIM_WINDOW_MS,
    })

    expect(offer?.userId).toBe(next)
    expect(await waitlistStatuses(banned)).toEqual(["waiting"])
  })

  it("a ban withdraws the user's waiting and offered places and releases the held seats", async () => {
    const cleanupId = await newCleanup()
    const main = await newTicketType(cleanupId)
    const vip = await newTicketType(cleanupId, { capacity: 3 })
    const extra = await newTicketType(cleanupId, { capacity: 3 })
    const userId = await newUser("To be banned")
    const now = new Date()
    for (const ticketTypeId of [vip, extra]) {
      await repo.joinWaitlist({
        cleanupId,
        ticketTypeId,
        subject: { kind: "user", userId },
        partySize: 3,
        accessCodeHash: null,
        now,
      })
    }
    await repo.offerNextWaitlistEntry({ ticketTypeId: vip, now, claimWindowMs: CLAIM_WINDOW_MS })
    expect(await reservedSeats(vip)).toBe(3)
    const registered = await repo.registerTx(selfRegistration(cleanupId, userId, main))
    if (registered.kind !== "registered") throw new Error("expected registered")

    const outcome = await repo.removeRegistration({
      cleanupId,
      registrationId: registered.registration.id,
      actorId: await newUser("Host"),
      ban: true,
      now,
    })

    expect(outcome.kind).toBe("cancelled")
    expect(outcome.releasedWaitlistTicketTypeIds).toEqual([vip])
    expect(await waitlistStatuses(userId)).toEqual(["cancelled", "cancelled"])
    expect(await reservedSeats(vip)).toBe(0)
    expect(await reservedSeats(main)).toBe(0)
    const bans = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_bans
       WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
    `
    expect(bans[0]?.n).toBe(1)
  })
})
