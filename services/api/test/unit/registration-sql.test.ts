import { describe, expect, it } from "vitest"
import { makeDrizzleHostRegistrationRepository } from "../../src/services/host/registration-repository.drizzle.js"
import { makeSqlRecorder, type SqlRecorder } from "../helpers/sql-recorder.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const TYPE_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1"
const TYPE_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2"
const TYPE_C = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3"
const NOW = new Date("2026-03-04T05:06:07.000Z")
const SORT_UPDATE = /^UPDATE cleanup_ticket_types/

function repoOver(rec: SqlRecorder) {
  return makeDrizzleHostRegistrationRepository(rec.sql)
}

function recorderWithTypes(...ids: string[]): SqlRecorder {
  const rec = makeSqlRecorder()
  rec.on(/^SELECT id FROM cleanup_ticket_types/, [...ids.map((id) => ({ id }))])
  return rec
}

describe("reordering ticket types", () => {
  it("writes every position with one UPDATE inside the transaction", async () => {
    const rec = recorderWithTypes(TYPE_A, TYPE_B, TYPE_C)

    const outcome = await repoOver(rec).reorderTicketTypes(EVENT, [TYPE_C, TYPE_A, TYPE_B], NOW)

    expect(outcome).toEqual({ kind: "reordered", items: [] })
    const updates = rec.queries.filter((q) => SORT_UPDATE.test(q.text))
    expect(updates).toHaveLength(1)
    expect(updates[0]?.scope).toBe("tx1")
    expect(updates[0]?.text).toBe(
      "UPDATE cleanup_ticket_types t SET sort_order = u.sort_order, updated_at = $1 " +
        "FROM unnest($2::uuid[], $3::int[]) AS u(id, sort_order) " +
        "WHERE t.id = u.id AND t.cleanup_id = $4",
    )
    expect(updates[0]?.params).toEqual([NOW, [TYPE_C, TYPE_A, TYPE_B], [0, 1, 2], EVENT])
    expect(rec.entries.at(-1)).toEqual({ type: "boundary", label: "COMMIT tx1" })
  })

  it("gives a repeated id its last position, once", async () => {
    const rec = recorderWithTypes(TYPE_A, TYPE_B)

    await repoOver(rec).reorderTicketTypes(EVENT, [TYPE_A, TYPE_B, TYPE_A], NOW)

    const update = rec.queries.find((q) => SORT_UPDATE.test(q.text))
    expect(update?.params).toEqual([NOW, [TYPE_A, TYPE_B], [2, 1], EVENT])
  })

  it("writes nothing when the list does not match the event's types", async () => {
    const rec = recorderWithTypes(TYPE_A, TYPE_B)

    const outcome = await repoOver(rec).reorderTicketTypes(EVENT, [TYPE_A, TYPE_C], NOW)

    expect(outcome).toEqual({ kind: "mismatch" })
    expect(rec.queries.some((q) => SORT_UPDATE.test(q.text))).toBe(false)
  })
})

describe("deleting a ticket type", () => {
  it("probes registrations and the waitlist within the event the type was locked in", async () => {
    const rec = makeSqlRecorder()
    rec.on(/^SELECT id FROM cleanup_ticket_types/, [{ id: TYPE_A }])
    rec.on(/^SELECT 1 AS one WHERE EXISTS/, [{ one: 1 }])

    const outcome = await repoOver(rec).deleteTicketType(EVENT, TYPE_A)

    expect(outcome).toEqual({ kind: "in_use" })
    const probe = rec.queries.find((q) => q.text.startsWith("SELECT 1 AS one WHERE EXISTS"))
    expect(probe?.text).toBe(
      "SELECT 1 AS one WHERE EXISTS ( SELECT 1 FROM cleanup_registrations " +
        "WHERE cleanup_id = $1 AND ticket_type_id = $2 ) OR EXISTS ( SELECT 1 FROM cleanup_waitlist " +
        "WHERE cleanup_id = $3 AND ticket_type_id = $4 )",
    )
    expect(probe?.params).toEqual([EVENT, TYPE_A, EVENT, TYPE_A])
    expect(rec.queries.some((q) => q.text.startsWith("DELETE"))).toBe(false)
  })
})
