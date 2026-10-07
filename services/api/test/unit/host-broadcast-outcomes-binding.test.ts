import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleBroadcastRepository } from "../../src/services/host/broadcast-repository.drizzle.js"

const SENT = "22222222-2222-2222-2222-222222222222"
const SUPPRESSED = "33333333-3333-3333-3333-333333333333"

describe("applyDeliveryOutcomes binds sent times Postgres can cast to timestamptz[]", () => {
  it("binds ISO strings, never Date objects, when the first outcome was sent", async () => {
    const fake = makeFakeSql()
    const repo = makeDrizzleBroadcastRepository(fake.sql as unknown as Sql)
    const sentAt = new Date("2026-09-23T10:00:00.123Z")

    await repo.applyDeliveryOutcomes([
      { id: SENT, status: "sent", sentAt },
      { id: SUPPRESSED, status: "suppressed", suppressionReason: "prefs_off" },
    ])

    const stmt = fake.statements.find((s) => /UPDATE broadcast_deliveries/.test(s.sql))
    expect(stmt, "applyDeliveryOutcomes should emit the UPDATE").toBeDefined()
    const arrays = stmt!.values.filter(Array.isArray)
    for (const values of arrays) {
      expect(values.some((v) => v instanceof Date)).toBe(false)
    }
    expect(arrays).toContainEqual(["2026-09-23T10:00:00.123Z", null])
  })
})
