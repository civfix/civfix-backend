import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { mintDemoSignupSeats } from "../../src/db/demo-join-event.js"
import type { Queryable } from "../../src/db/client.js"

const EVENT_ID = "33333333-3333-3333-3333-333333333333"
const MEMBERS = [
  { user_id: "44444444-4444-4444-4444-444444444444", joined_at: new Date("2026-09-01T18:00:00Z") },
  { user_id: "55555555-5555-5555-5555-555555555555", joined_at: new Date("2026-09-02T18:00:00Z") },
]

describe("demo joins mint the free registration + seat the live join path mints", () => {
  it("writes one registration and one hashed seat per joined member", async () => {
    let registration = 0
    const fake = makeFakeSql([
      {
        match: /INSERT INTO cleanup_registrations/,
        rows: () => [{ id: `registration-${++registration}` }],
      },
    ])
    const minted = await mintDemoSignupSeats(fake.sql as unknown as Queryable, {
      cleanupId: EVENT_ID,
      members: MEMBERS,
      hashFor: (seatId) => `hash:${seatId}`,
    })

    expect(minted).toBe(2)
    const seats = fake.statements.filter((s) =>
      /INSERT INTO cleanup_registration_seats/.test(s.sql),
    )
    expect(seats).toHaveLength(2)
    for (const seat of seats) {
      const seatId = seat.values[0] as string
      expect(seat.values).toContain(`hash:${seatId}`)
    }
  })

  it("mints nothing on a ticketed event, exactly like the live join", async () => {
    const fake = makeFakeSql([{ match: /FROM cleanup_ticket_types/, rows: [{ one: 1 }] }])
    const minted = await mintDemoSignupSeats(fake.sql as unknown as Queryable, {
      cleanupId: EVENT_ID,
      members: MEMBERS,
      hashFor: (seatId) => `hash:${seatId}`,
    })
    expect(minted).toBe(0)
    expect(fake.statements.some((s) => /INSERT INTO cleanup_registrations/.test(s.sql))).toBe(false)
  })
})
