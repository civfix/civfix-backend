import { afterEach, describe, expect, it, vi } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { demoTicketTokenHasher, mintDemoSignupSeats } from "../../src/db/demo-signup-seats.js"
import type { Queryable } from "../../src/db/client.js"
import { DEVELOPMENT_TICKET_TOKEN_SECRET } from "../../src/env/registration-env.js"
import { makeTicketTokenSigner } from "../../src/services/host/ticket-token.js"

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

describe("demo seat hashes use the secret the API resolves", () => {
  const SEAT_ID = "66666666-6666-6666-6666-666666666666"
  const API_SECRET = "an-api-ticket-token-secret-of-at-least-32-chars"

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("falls back to the development secret outside production, as the API does", () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("TICKET_TOKEN_SECRET", "")
    const expected = makeTicketTokenSigner(DEVELOPMENT_TICKET_TOKEN_SECRET).hashFor(SEAT_ID)
    expect(demoTicketTokenHasher()(SEAT_ID)).toBe(expected)
  })

  it("hashes with the configured secret", () => {
    const hashFor = demoTicketTokenHasher({
      NODE_ENV: "production",
      TICKET_TOKEN_SECRET: ` ${API_SECRET} `,
    })
    expect(hashFor(SEAT_ID)).toBe(makeTicketTokenSigner(API_SECRET).hashFor(SEAT_ID))
  })

  it("refuses a production run without the API's secret", () => {
    expect(() => demoTicketTokenHasher({ NODE_ENV: "production" })).toThrow(
      /TICKET_TOKEN_SECRET: required \[BOOT\] variable is missing/,
    )
  })

  it("refuses the development secret in production, where no real seat would scan", () => {
    expect(() =>
      demoTicketTokenHasher({
        NODE_ENV: "production",
        TICKET_TOKEN_SECRET: DEVELOPMENT_TICKET_TOKEN_SECRET,
      }),
    ).toThrow(/insecure dev default/)
  })
})
