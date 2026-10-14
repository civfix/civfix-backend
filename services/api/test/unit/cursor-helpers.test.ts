import { describe, it, expect } from "vitest"
import {
  CURSOR_UUID_RE,
  MAX_UUID,
  MIN_UUID,
  encodeNameCursor,
  encodeNearCursor,
  encodeKeysetCursor,
  encodeTimeCursor,
  isUuid,
  pageWith,
  paginate,
  parseNameCursor,
  parseNearCursor,
  parseKeysetCursor,
  parseTimeCursor,
} from "../../src/db/cursor-helpers.js"

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
const UUID_2 = "9c858901-8a57-4791-81fe-4c455b099bc9"
const ISO = "2026-07-24T12:34:56.789Z"

describe("isUuid / CURSOR_UUID_RE", () => {
  it("accepts a canonical uuid in either case and rejects near-misses", () => {
    expect(isUuid(UUID)).toBe(true)
    expect(isUuid(UUID.toUpperCase())).toBe(true)
    expect(isUuid(UUID.replace(/-/g, ""))).toBe(false)
    expect(isUuid(`${UUID}x`)).toBe(false)
    expect(isUuid(` ${UUID}`)).toBe(false)
    expect(isUuid("3f2504e0-4f89-11d3-9a0c-0305e82c330")).toBe(false)
    expect(isUuid("zzzzzzzz-4f89-11d3-9a0c-0305e82c3301")).toBe(false)
    expect(isUuid("")).toBe(false)
  })

  it("is anchored at both ends (a uuid embedded in a longer string does not match)", () => {
    expect(CURSOR_UUID_RE.test(`prefix-${UUID}-suffix`)).toBe(false)
  })
})

describe("parseTimeCursor", () => {
  it("parses an '<iso>|<uuid>' cursor", () => {
    const parsed = parseTimeCursor(`${ISO}|${UUID}`)
    expect(parsed).not.toBeNull()
    expect(parsed!.id).toBe(UUID)
    expect(parsed!.at.toISOString()).toBe(ISO)
  })

  it("round-trips through encodeTimeCursor", () => {
    const original = { at: new Date(ISO), id: UUID }
    const encoded = encodeTimeCursor(original)
    expect(encoded).toBe(`${ISO}|${UUID}`)
    const parsed = parseTimeCursor(encoded)
    expect(parsed!.at.getTime()).toBe(original.at.getTime())
    expect(parsed!.id).toBe(original.id)
  })

  it("keeps the cursor's microseconds as the instant the database compares against", () => {
    const parsed = parseKeysetCursor(`2026-07-24T12:34:56.789123Z|${UUID}`)
    expect(parsed?.at.toISOString()).toBe(ISO)
    expect(parsed?.atText).toBe("2026-07-24T12:34:56.789123Z")
    expect(parseKeysetCursor(`2026-07-24T14:34:56.7+02:00|${UUID}`)?.atText).toBe(
      "2026-07-24T12:34:56.7Z",
    )
  })

  it("encodes a database instant verbatim, so its microseconds survive the round trip", () => {
    const encoded = encodeKeysetCursor("2026-07-24T12:34:56.789123Z", UUID)
    expect(encoded).toBe(`2026-07-24T12:34:56.789123Z|${UUID}`)
    expect(parseKeysetCursor(encoded)?.atText).toBe("2026-07-24T12:34:56.789123Z")
  })

  it("anchors a legacy timestamp-only cursor with a DIRECTION-AWARE sentinel so no boundary row is skipped", () => {
    const anchor = { at: new Date(ISO) }
    expect(parseTimeCursor(ISO)).toEqual({ ...anchor, id: MAX_UUID })
    expect(parseTimeCursor(ISO, { direction: "desc" })).toEqual({ ...anchor, id: MAX_UUID })
    expect(parseTimeCursor(ISO, { direction: "asc" })).toEqual({ ...anchor, id: MIN_UUID })
    expect(isUuid(parseTimeCursor(ISO)!.id)).toBe(true)
    expect(isUuid(parseTimeCursor(ISO, { direction: "asc" })!.id)).toBe(true)
  })

  it("returns null for absent / empty cursors", () => {
    expect(parseTimeCursor(null)).toBeNull()
    expect(parseTimeCursor(undefined)).toBeNull()
    expect(parseTimeCursor("")).toBeNull()
  })

  it("returns null for garbage (an unparseable timestamp, with or without an id)", () => {
    expect(parseTimeCursor("not-a-date")).toBeNull()
    expect(parseTimeCursor(`not-a-date|${UUID}`)).toBeNull()
    expect(parseTimeCursor("garbage|garbage")).toBeNull()
    expect(parseTimeCursor("|")).toBeNull()
  })

  it("returns null for a NON-UUID id (the 22P02 guard) by default", () => {
    expect(parseTimeCursor(`${ISO}|not-a-uuid`)).toBeNull()
    expect(parseTimeCursor(`${ISO}|1; DROP TABLE users`)).toBeNull()
    expect(parseTimeCursor(`${ISO}|`)).toBeNull()
  })

  it("returns null when the anchor is empty (a leading '|')", () => {
    expect(parseTimeCursor(`|${UUID}`)).toBeNull()
  })

  it("with requireUuid:false accepts a non-uuid id, but still rejects an EMPTY one", () => {
    const parsed = parseTimeCursor(`${ISO}|room-42`, { requireUuid: false })
    expect(parsed).toEqual({ at: new Date(ISO), id: "room-42" })
    expect(parseTimeCursor(`${ISO}|`, { requireUuid: false })).toBeNull()
    expect(parseTimeCursor("nope|room-42", { requireUuid: false })).toBeNull()
  })

  it("splits on the FIRST '|' (unlike parseNameCursor, which splits on the last)", () => {
    expect(parseTimeCursor(`${ISO}|${UUID}|extra`)).toBeNull()
    expect(parseTimeCursor(`${ISO}|${UUID}|extra`, { requireUuid: false })!.id).toBe(
      `${UUID}|extra`,
    )
  })

  it("rejects a forged out-of-range timestamp that JS parses but Postgres would 22008 on", () => {
    expect(parseTimeCursor(`-271821-04-20T00:00:00Z|${UUID}`)).toBeNull()
    expect(parseTimeCursor("-271821-04-20T00:00:00Z")).toBeNull()
    expect(parseTimeCursor(`+275760-09-13T00:00:00Z|${UUID}`)).toBeNull()
    expect(parseTimeCursor(`1969-12-31T23:59:59.999Z|${UUID}`)).toBeNull()
    expect(parseTimeCursor(`2101-01-01T00:00:00.000Z|${UUID}`)).toBeNull()
  })

  it("rejects loosely-parsable non-ISO anchors JS would otherwise accept", () => {
    expect(parseTimeCursor(`2026|${UUID}`)).toBeNull()
    expect(parseTimeCursor(`2026-07-24|${UUID}`)).toBeNull()
    expect(parseTimeCursor(`Wed Jul 24 2026|${UUID}`)).toBeNull()
    expect(parseTimeCursor(`2026-07-24T12:34:56.789Z ${UUID}`)).toBeNull()
  })

  it("accepts every shape the encoders emit, plus an explicit UTC offset", () => {
    for (const at of [new Date(0), new Date(ISO), new Date("2099-12-31T23:59:59.999Z")]) {
      const parsed = parseTimeCursor(encodeTimeCursor({ at, id: UUID }))
      expect(parsed!.at.getTime()).toBe(at.getTime())
    }
    expect(parseTimeCursor(`2026-07-24T12:34:56+02:00|${UUID}`)!.at.toISOString()).toBe(
      "2026-07-24T10:34:56.000Z",
    )
  })
})

describe("parseNameCursor / encodeNameCursor", () => {
  it("round-trips a plain name", () => {
    expect(parseNameCursor(encodeNameCursor({ name: "Ada Lovelace", id: UUID }))).toEqual({
      name: "Ada Lovelace",
      id: UUID,
    })
  })

  it("splits on the LAST '|' so a name may itself contain the delimiter", () => {
    const name = "Bar | Grill | Co"
    const encoded = encodeNameCursor({ name, id: UUID })
    expect(encoded).toBe(`${name}|${UUID}`)
    expect(parseNameCursor(encoded)).toEqual({ name, id: UUID })
  })

  it("returns null for absent / delimiter-less / non-uuid cursors", () => {
    expect(parseNameCursor(null)).toBeNull()
    expect(parseNameCursor(undefined)).toBeNull()
    expect(parseNameCursor("")).toBeNull()
    expect(parseNameCursor("Ada Lovelace")).toBeNull()
    expect(parseNameCursor("Ada|not-a-uuid")).toBeNull()
    expect(parseNameCursor("Ada|")).toBeNull()
  })

  it("allows an EMPTY name (a display name can legitimately sort first as '')", () => {
    expect(parseNameCursor(`|${UUID}`)).toEqual({ name: "", id: UUID })
  })
})

describe("parseNearCursor / encodeNearCursor", () => {
  it("round-trips a distance anchor", () => {
    const encoded = encodeNearCursor({ dist: 1234.5, id: UUID })
    expect(encoded).toBe(`1234.5|${UUID}`)
    expect(parseNearCursor(encoded)).toEqual({ dist: 1234.5, id: UUID })
  })

  it("parses a zero distance and exponent notation (a 0 anchor is legitimate: you are AT the point)", () => {
    expect(parseNearCursor(`0|${UUID}`)).toEqual({ dist: 0, id: UUID })
    expect(parseNearCursor(`0.0|${UUID}`)).toEqual({ dist: 0, id: UUID })
    expect(parseNearCursor(`1e3|${UUID}`)).toEqual({ dist: 1000, id: UUID })
  })

  it("returns null for a non-numeric or non-finite distance", () => {
    expect(parseNearCursor(`abc|${UUID}`)).toBeNull()
    expect(parseNearCursor(`Infinity|${UUID}`)).toBeNull()
    expect(parseNearCursor(`NaN|${UUID}`)).toBeNull()
  })

  it("returns null for absent / delimiter-less / leading-delimiter / non-uuid cursors", () => {
    expect(parseNearCursor(null)).toBeNull()
    expect(parseNearCursor(undefined)).toBeNull()
    expect(parseNearCursor("")).toBeNull()
    expect(parseNearCursor("12.5")).toBeNull()
    expect(parseNearCursor(`|${UUID}`)).toBeNull()
    expect(parseNearCursor("12.5|not-a-uuid")).toBeNull()
  })
})

describe("pageWith", () => {
  const encode = (row: { id: string }): string => `enc:${row.id}`

  it("returns every row and NO cursor when the page is not full", () => {
    expect(pageWith([{ id: "a" }, { id: "b" }], 3, encode)).toEqual({
      items: [{ id: "a" }, { id: "b" }],
      nextCursor: null,
    })
  })

  it("returns exactly `limit` rows and NO cursor when rows.length === limit (no probe row)", () => {
    expect(pageWith([{ id: "a" }, { id: "b" }], 2, encode)).toEqual({
      items: [{ id: "a" }, { id: "b" }],
      nextCursor: null,
    })
  })

  it("drops the has-more probe row and encodes from the LAST EMITTED row", () => {
    const page = pageWith([{ id: "a" }, { id: "b" }, { id: "c" }], 2, encode)
    expect(page.items).toEqual([{ id: "a" }, { id: "b" }])
    expect(page.nextCursor).toBe("enc:b")
  })

  it("ends the page when the encoder cannot anchor the last row", () => {
    const page = pageWith([{ id: "a" }, { id: "b" }], 1, () => null)
    expect(page.items).toEqual([{ id: "a" }])
    expect(page.nextCursor).toBeNull()
  })

  it("never calls the encoder when there is no next page", () => {
    let calls = 0
    pageWith([{ id: "a" }], 2, (row) => {
      calls += 1
      return encode(row)
    })
    expect(calls).toBe(0)
  })

  it("handles limit 0 without producing a cursor for a row it did not emit", () => {
    expect(pageWith([{ id: "a" }], 0, encode)).toEqual({ items: [], nextCursor: null })
  })
})

describe("paginate", () => {
  it("encodes a time cursor from the last emitted row's `at`", () => {
    const rows = [
      { id: UUID, at: new Date(ISO) },
      { id: UUID_2, at: new Date("2026-07-23T00:00:00.000Z") },
    ]
    const page = paginate(rows, 1, (r) => ({ at: r.at, id: r.id }))
    expect(page.items).toEqual([rows[0]])
    expect(page.nextCursor).toBe(`${ISO}|${UUID}`)
    expect(parseTimeCursor(page.nextCursor)).toEqual({ at: new Date(ISO), id: UUID })
  })

  it("falls back to `createdAt` when the anchor has no `at`", () => {
    const rows = [
      { id: UUID, createdAt: new Date(ISO) },
      { id: UUID_2, createdAt: new Date(ISO) },
    ]
    const page = paginate(rows, 1, (r) => ({ createdAt: r.createdAt, id: r.id }))
    expect(page.nextCursor).toBe(`${ISO}|${UUID}`)
  })

  it("ends the page when the last row carries no timestamp to anchor on", () => {
    const rows = [{ id: UUID }, { id: UUID_2 }]
    const page = paginate(rows, 1, (r) => ({ id: r.id }))
    expect(page.items).toEqual([rows[0]])
    expect(page.nextCursor).toBeNull()
  })

  it("returns no cursor for a short page", () => {
    const rows = [{ id: UUID, at: new Date(ISO) }]
    expect(paginate(rows, 5, (r) => ({ at: r.at, id: r.id })).nextCursor).toBeNull()
  })
})
