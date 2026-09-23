import { describe, expect, it } from "vitest"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import type { CreateCleanupTxArgs, DesiredSlot } from "../../src/services/cleanup-repository.js"
import { makeSqlRecorder, type SqlRecorder } from "../helpers/sql-recorder.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ORGANIZER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const SLOT_INSERT = /INSERT INTO cleanup_slots/

function createArgs(slots: DesiredSlot[]): CreateCleanupTxArgs {
  return {
    cleanupId: EVENT,
    organizerUserId: ORGANIZER,
    type: "site",
    eventKind: "cleanup",
    title: "Beach cleanup",
    description: null,
    lat: 33.99,
    lng: -118.47,
    scheduledAt: new Date("2026-10-01T17:00:00.000Z"),
    status: "upcoming",
    bring: null,
    address: null,
    addressSource: null,
    jurisdictionGeoid: null,
    jurCode: 1,
    linkedReportIds: [],
    slots,
    host: { endsAt: new Date("2026-10-01T21:00:00.000Z") },
  }
}

// The re-read after the inserts answers with no row, so the create stops there with a 500; every
// statement up to it, the slot insert included, has already been recorded.
async function createWith(slots: DesiredSlot[]): Promise<SqlRecorder> {
  const rec = makeSqlRecorder()
  rec.on(/reference_counters/, [{ next_val: 1 }])
  await expect(
    makeDrizzleCleanupRepository(rec.sql as unknown as Sql).createCleanupTx(createArgs(slots)),
  ).rejects.toMatchObject({ httpStatus: 500 })
  return rec
}

describe("creating an event writes its slots in one statement", () => {
  it("inserts every slot with one unnest statement, in the desired order", async () => {
    const rec = await createWith([
      {
        title: "Grill",
        description: "Burgers",
        capacity: 4,
        startsAt: new Date("2026-10-01T17:00:00.000Z"),
        endsAt: new Date("2026-10-01T18:00:00.000Z"),
        sortOrder: 0,
      },
      {
        title: "Litter",
        description: null,
        capacity: null,
        startsAt: null,
        endsAt: null,
        sortOrder: 1,
      },
      {
        title: "Sorting",
        description: null,
        capacity: 2,
        startsAt: new Date("2026-10-01T19:00:00.000Z"),
        endsAt: new Date("2026-10-01T20:00:00.000Z"),
        sortOrder: 2,
      },
    ])

    const inserts = rec.queries.filter((q) => SLOT_INSERT.test(q.text))
    expect(inserts).toHaveLength(1)
    expect(inserts[0]?.scope).toBe("tx1")
    expect(inserts[0]?.text).toBe(
      "INSERT INTO cleanup_slots (cleanup_id, title, description, capacity, starts_at, ends_at, sort_order) " +
        "SELECT $1, s.title, s.description, s.capacity, s.starts_at, s.ends_at, s.sort_order " +
        "FROM unnest( $2::text[], $3::text[], $4::int[], $5::timestamptz[], $6::timestamptz[], $7::int[] ) " +
        "AS s(title, description, capacity, starts_at, ends_at, sort_order)",
    )
    expect(inserts[0]?.params).toEqual([
      EVENT,
      ["Grill", "Litter", "Sorting"],
      ["Burgers", null, null],
      [4, null, 2],
      ["2026-10-01T17:00:00.000Z", null, "2026-10-01T19:00:00.000Z"],
      ["2026-10-01T18:00:00.000Z", null, "2026-10-01T20:00:00.000Z"],
      [0, 1, 2],
    ])
  })

  it("binds timestamps as strings so a leading Date never types the array as a scalar", async () => {
    const rec = await createWith([
      {
        title: "Grill",
        description: null,
        capacity: null,
        startsAt: new Date("2026-10-01T17:00:00.000Z"),
        endsAt: new Date("2026-10-01T18:00:00.000Z"),
        sortOrder: 0,
      },
    ])

    const insert = rec.queries.find((q) => SLOT_INSERT.test(q.text))
    for (const param of insert?.params ?? []) {
      const values = Array.isArray(param) ? param : [param]
      for (const value of values) expect(value).not.toBeInstanceOf(Date)
    }
  })

  it("sends no slot statement for an event without slots", async () => {
    const rec = await createWith([])

    expect(rec.queries.some((q) => SLOT_INSERT.test(q.text))).toBe(false)
  })
})
