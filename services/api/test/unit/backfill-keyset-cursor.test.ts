import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { stampReferenceCodes, type ReferenceCodeRow } from "../../src/db/backfill-keyset.js"
import type { Sql } from "../../src/db/client.js"

const MAX_PAGES = 20

interface StoredRow {
  id: string
  createdAtIso: string
  referenceCode: string | null
}

function micros(iso: string): bigint {
  const m = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(iso)
  if (m === null) throw new Error(`unexpected instant ${iso}`)
  const seconds = BigInt(Date.parse(`${m[1]}Z`)) * 1000n
  return seconds + BigInt((m[2] ?? "").padEnd(6, "0"))
}

function boundMicros(value: unknown): bigint {
  if (value instanceof Date) return BigInt(value.getTime()) * 1000n
  return micros(String(value))
}

function keysetTable(rows: StoredRow[]) {
  let pages = 0
  return makeFakeSql([
    {
      match: /SELECT t\.id, t\.created_at/,
      rows: (bound) => {
        const values = bound.filter((v) => !(typeof v === "string" && v.includes("HH24")))
        pages += 1
        if (pages > MAX_PAGES) throw new Error("keyset loop never terminated")
        const limit = Number(values[values.length - 1])
        const after =
          values.length === 3 ? { at: boundMicros(values[0]), id: String(values[1]) } : null
        return rows
          .filter((r) => r.referenceCode === null)
          .filter((r) => {
            if (after === null) return true
            const at = micros(r.createdAtIso)
            return at > after.at || (at === after.at && r.id > after.id)
          })
          .sort((a, b) => Number(micros(a.createdAtIso) - micros(b.createdAtIso)))
          .slice(0, limit)
          .map((r) => ({
            id: r.id,
            created_at: new Date(r.createdAtIso),
            cursor_at: r.createdAtIso,
            jur_code: null,
          }))
      },
    },
    {
      match: /UPDATE reports/,
      rows: (values) => {
        const row = rows.find((r) => r.id === values[1])
        if (row) row.referenceCode = String(values[0])
        return []
      },
    },
  ])
}

describe("stampReferenceCodes keyset cursor", () => {
  it("terminates when the last unstamped row keeps failing and has sub-millisecond precision", async () => {
    const rows: StoredRow[] = [
      { id: "a", createdAtIso: "2026-01-01T00:00:00.100250Z", referenceCode: null },
      { id: "b", createdAtIso: "2026-01-01T00:00:00.200750Z", referenceCode: null },
    ]
    const fake = keysetTable(rows)
    const result = await stampReferenceCodes<ReferenceCodeRow>(fake.sql as unknown as Sql, {
      table: "reports",
      batchSize: 1,
      label: "test",
      extraColumn: null,
      allocate: (_tx, row) =>
        row.id === "b" ? Promise.reject(new Error("allocator refused")) : Promise.resolve("R-1"),
    })
    expect(result).toEqual({ stamped: 1, failed: 1 })
  })
})
