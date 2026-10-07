import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleHostRegistrationRepository } from "../../src/services/host/registration-repository.drizzle.js"
import type { HostRegistrationRepository } from "../../src/services/host/registration-repository.js"

const pg = await withPg()
const FUTURE = new Date(Date.now() + 7 * 86_400_000)

describe.skipIf(!pg)("ticket type reorder and delete (integration)", () => {
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
    return u!.id
  }

  async function newCleanup(): Promise<string> {
    return await seedCleanup(h.sql, {
      organizerUserId: await newUser("Organizer"),
      title: "Ticket type sweep",
      lng: -118.25,
      lat: 34.05,
      scheduledAt: FUTURE,
    })
  }

  async function newTicketType(cleanupId: string, sortOrder: number): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_ticket_types (cleanup_id, name, capacity, max_party_size, waitlist_enabled, sort_order)
      VALUES (${cleanupId}, ${`Type ${randomUUID().slice(0, 8)}`}, 5, 4, true, ${sortOrder})
      RETURNING id
    `
    return row!.id
  }

  async function sortOrders(cleanupId: string): Promise<Map<string, number>> {
    const rows = await h.sql<{ id: string; sort_order: number }[]>`
      SELECT id, sort_order FROM cleanup_ticket_types WHERE cleanup_id = ${cleanupId}
    `
    return new Map(rows.map((r) => [r.id, r.sort_order]))
  }

  async function typeExists(ticketTypeId: string): Promise<boolean> {
    const rows = await h.sql`SELECT 1 FROM cleanup_ticket_types WHERE id = ${ticketTypeId}`
    return rows.length > 0
  }

  it("stores every new position and leaves another event's types alone", async () => {
    const cleanupId = await newCleanup()
    const a = await newTicketType(cleanupId, 0)
    const b = await newTicketType(cleanupId, 1)
    const c = await newTicketType(cleanupId, 2)
    const otherEvent = await newCleanup()
    const other = await newTicketType(otherEvent, 7)
    const now = new Date()

    const outcome = await repo.reorderTicketTypes(cleanupId, [c, a, b], now)

    expect(outcome.kind).toBe("reordered")
    if (outcome.kind === "reordered") expect(outcome.items.map((t) => t.id)).toEqual([c, a, b])
    expect(await sortOrders(cleanupId)).toEqual(
      new Map([
        [c, 0],
        [a, 1],
        [b, 2],
      ]),
    )
    expect(await sortOrders(otherEvent)).toEqual(new Map([[other, 7]]))
  })

  it("gives a repeated id its last position", async () => {
    const cleanupId = await newCleanup()
    const a = await newTicketType(cleanupId, 0)
    const b = await newTicketType(cleanupId, 1)

    await repo.reorderTicketTypes(cleanupId, [a, b, a], new Date())

    expect(await sortOrders(cleanupId)).toEqual(
      new Map([
        [a, 2],
        [b, 1],
      ]),
    )
  })

  it("refuses to delete a type that only a cancelled registration still references", async () => {
    const cleanupId = await newCleanup()
    const ticketTypeId = await newTicketType(cleanupId, 0)
    await h.sql`
      INSERT INTO cleanup_registrations (cleanup_id, ticket_type_id, user_id, status, cancelled_at)
      VALUES (${cleanupId}, ${ticketTypeId}, ${await newUser("Cancelled")}, 'cancelled', now())
    `

    expect(await repo.deleteTicketType(cleanupId, ticketTypeId)).toEqual({ kind: "in_use" })
    expect(await typeExists(ticketTypeId)).toBe(true)
  })

  it("refuses to delete a type that only a cancelled waitlist entry still references", async () => {
    const cleanupId = await newCleanup()
    const ticketTypeId = await newTicketType(cleanupId, 0)
    await h.sql`
      INSERT INTO cleanup_waitlist (cleanup_id, ticket_type_id, user_id, status)
      VALUES (${cleanupId}, ${ticketTypeId}, ${await newUser("Left the queue")}, 'cancelled')
    `

    expect(await repo.deleteTicketType(cleanupId, ticketTypeId)).toEqual({ kind: "in_use" })
    expect(await typeExists(ticketTypeId)).toBe(true)
  })

  it("deletes a type nothing references", async () => {
    const cleanupId = await newCleanup()
    const ticketTypeId = await newTicketType(cleanupId, 0)
    const sibling = await newTicketType(cleanupId, 1)
    await h.sql`
      INSERT INTO cleanup_registrations (cleanup_id, ticket_type_id, user_id)
      VALUES (${cleanupId}, ${sibling}, ${await newUser("Sibling holder")})
    `

    expect(await repo.deleteTicketType(cleanupId, ticketTypeId)).toEqual({ kind: "deleted" })
    expect(await typeExists(ticketTypeId)).toBe(false)
  })
})
