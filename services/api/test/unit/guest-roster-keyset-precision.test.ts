import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import { parseKeysetCursor } from "../../src/db/cursor-helpers.js"
import { makeDrizzleGuestRsvpRepository } from "../../src/services/guest-rsvp-repository.drizzle.js"

const CLEANUP = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e00"
const ID_A = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e01"
const ID_B = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e02"
const AT = new Date("2026-09-01T10:00:00.123Z")
const AT_TEXT = "2026-09-01T10:00:00.123000Z"
const LEGACY_AT_TEXT = "2026-09-01T10:00:00.123Z"
const MATCH = /FROM cleanup_guests\s+WHERE cleanup_id = \?/

function guestRow(id: string, cursorAt: string): Record<string, unknown> {
  return {
    id,
    name: "Guest",
    channel: "email",
    email: "guest@example.org",
    phone: null,
    verified_at: AT,
    cancelled_at: null,
    created_at: AT,
    cursor_at: cursorAt,
  }
}

function lastRosterStatement(ctl: ReturnType<typeof makeFakeSql>): {
  sql: string
  values: unknown[]
} {
  const hit = [...ctl.statements].reverse().find((s) => MATCH.test(s.sql))
  if (hit === undefined) throw new Error("no roster statement")
  return hit
}

// The guest roster keysets on the same exact-text anchor as every other time-ordered list, so its
// cursor cannot drift from the column's stored precision.
describe("guest roster keyset cursor", () => {
  it("encodes the next cursor from the column's own text and binds it back as text", async () => {
    const ctl = makeFakeSql([
      { match: MATCH, rows: [guestRow(ID_A, AT_TEXT), guestRow(ID_B, AT_TEXT)] },
    ])
    const repo = makeDrizzleGuestRsvpRepository(ctl.sql as unknown as Sql)

    const page1 = await repo.listGuests({ cleanupId: CLEANUP, cursor: null, limit: 1 })
    expect(page1.nextCursor).toBe(`${AT_TEXT}|${ID_A}`)
    expect(lastRosterStatement(ctl).sql).toMatch(/to_char\(created_at AT TIME ZONE 'UTC', \?\)/)

    await repo.listGuests({
      cleanupId: CLEANUP,
      cursor: parseKeysetCursor(page1.nextCursor, { direction: "desc" }),
      limit: 1,
    })
    const stmt = lastRosterStatement(ctl)
    expect(stmt.sql).toContain("(created_at, id) < (?::timestamptz, ?::uuid)")
    expect(stmt.values).toContain(AT_TEXT)
    expect(stmt.values.some((v) => v instanceof Date)).toBe(false)
  })

  it("still pages from a legacy millisecond cursor at the instant it always meant", async () => {
    const ctl = makeFakeSql([{ match: MATCH, rows: [] }])
    const repo = makeDrizzleGuestRsvpRepository(ctl.sql as unknown as Sql)
    await repo.listGuests({
      cleanupId: CLEANUP,
      cursor: parseKeysetCursor(`${LEGACY_AT_TEXT}|${ID_A}`, { direction: "desc" }),
      limit: 1,
    })
    expect(lastRosterStatement(ctl).values).toContain(LEGACY_AT_TEXT)
  })
})
