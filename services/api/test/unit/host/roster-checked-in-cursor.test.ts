import { describe, expect, it } from "vitest"
import type { Sql } from "../../../src/db/client.js"
import { makeDrizzleHostRegistrationRepository } from "../../../src/services/host/registration-repository.drizzle.js"
import type { RosterQuery } from "../../../src/services/host/registration-repository.js"
import { makeFakeSql } from "../../helpers/fake-sql.js"

const EVENT = "11111111-1111-4111-8111-111111111111"
const EPOCH = new Date(0)
const PAGE_SIZE = 2

interface RosterRow {
  id: string
  registered_at: Date
  checked_in_at: Date | null
  cursor_at: string
  checked_in_cursor_at: string
}

const CHECKED_IN = row("aaaaaaaa-0000-4000-8000-000000000009", "2026-09-01T09:00:00.000Z", {
  checkedInAt: "2026-09-02T10:00:00.000Z",
})
const LATEST = row("aaaaaaaa-0000-4000-8000-000000000001", "2026-09-01T12:00:00.000Z")
const MIDDLE = row("aaaaaaaa-0000-4000-8000-000000000003", "2026-09-01T11:00:00.000Z")
const EARLIEST = row("aaaaaaaa-0000-4000-8000-000000000002", "2026-09-01T10:00:00.000Z")
const ROSTER = [CHECKED_IN, LATEST, MIDDLE, EARLIEST]

/** The instant as Postgres renders it for a cursor: microsecond text in UTC. */
function microText(at: Date): string {
  return at.toISOString().replace("Z", "000Z")
}

const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/

function micros(text: string): number {
  const match = ISO_INSTANT.exec(text)
  if (match === null) throw new Error(`not an instant: ${text}`)
  return Date.parse(`${match[1]}Z`) * 1000 + Number((match[2] ?? "").padEnd(6, "0"))
}

function row(id: string, registeredAt: string, opts: { checkedInAt?: string } = {}): RosterRow {
  const checkedInAt = opts.checkedInAt === undefined ? null : new Date(opts.checkedInAt)
  return {
    id,
    registered_at: new Date(registeredAt),
    checked_in_at: checkedInAt,
    cursor_at: microText(new Date(registeredAt)),
    checked_in_cursor_at: microText(checkedInAt ?? EPOCH),
  }
}

function orderKey(r: RosterRow): [number, number, string] {
  return [micros(r.checked_in_cursor_at), micros(r.cursor_at), r.id]
}

function tupleBefore(left: (number | string)[], right: (number | string)[]): boolean {
  for (let i = 0; i < left.length; i += 1) {
    if (left[i]! < right[i]!) return true
    if (left[i]! > right[i]!) return false
  }
  return false
}

function asKeyPart(value: unknown): number | string {
  if (value instanceof Date) return value.getTime() * 1000
  const text = String(value)
  return ISO_INSTANT.test(text) ? micros(text) : text
}

/**
 * Serves the roster the way Postgres would: ORDER BY the checked_in_at_desc keys, then the recorded
 * cursor predicate, whose tuple width is read off the statement so the old two-column shape is
 * evaluated as written rather than as intended.
 */
function servedRoster(sqlText: string, values: unknown[]): RosterRow[] {
  const limit = values[values.length - 1] as number
  const anchor = values.slice(values.indexOf(EVENT) + 1, -1).map(asKeyPart)
  const ordered = [...ROSTER].sort((a, b) => (tupleBefore(orderKey(a), orderKey(b)) ? 1 : -1))
  let visible = ordered
  if (/'epoch'::timestamptz\), r\.registered_at, r\.id\) < \(/.test(sqlText)) {
    visible = ordered.filter((r) => tupleBefore(orderKey(r), anchor))
  } else if (/'epoch'::timestamptz\), r\.id\) < \(/.test(sqlText)) {
    visible = ordered.filter((r) => tupleBefore([orderKey(r)[0], r.id], anchor))
  } else if (/'epoch'::timestamptz\) <= \?/.test(sqlText)) {
    visible = ordered.filter((r) => orderKey(r)[0] <= (anchor[0] as number))
  } else if (anchor.length > 0) {
    throw new Error(`unrecognised roster cursor predicate: ${sqlText}`)
  }
  return visible.slice(0, limit)
}

async function page(cursor: string | null): Promise<{ ids: string[]; nextCursor: string | null }> {
  const query: RosterQuery = {
    cleanupId: EVENT,
    filter: "all",
    ticketTypeId: null,
    slotId: null,
    sort: "checked_in_at_desc",
    q: null,
    cursor,
    limit: PAGE_SIZE,
    withTotal: false,
  }
  const served = makeFakeSql([
    {
      match: /FROM cleanup_registrations r\b[\s\S]*ORDER BY/,
      rows: (values) => {
        const statement = served.statements[served.statements.length - 1]!
        return servedRoster(statement.sql, values)
      },
    },
  ])
  const result = await makeDrizzleHostRegistrationRepository(
    served.sql as unknown as Sql,
  ).listRoster(query)
  return { ids: result.rows.map((r) => r.id), nextCursor: result.nextCursor }
}

async function walk(first: string | null): Promise<string[]> {
  const seen: string[] = []
  let cursor = first
  for (let guard = 0; guard < ROSTER.length + 2; guard += 1) {
    const next = await page(cursor)
    seen.push(...next.ids)
    if (next.nextCursor === null) return seen
    cursor = next.nextCursor
  }
  throw new Error("roster paging never ended")
}

describe("the checked-in roster sort pages on its full ORDER BY", () => {
  it("serves page 2 past a tie on the check-in time without skipping or repeating", async () => {
    const first = await page(null)
    expect(first.ids).toEqual([CHECKED_IN.id, LATEST.id])

    const second = await page(first.nextCursor)

    expect(second.ids).toEqual([MIDDLE.id, EARLIEST.id])
  })

  it("visits every registration exactly once across all pages", async () => {
    await expect(walk(null)).resolves.toEqual(ROSTER.map((r) => r.id))
  })

  it("still accepts a cursor issued before registered_at joined it, repeating ties rather than skipping", async () => {
    const legacy = `${EPOCH.toISOString()}|${LATEST.id}`

    const seen = await walk(legacy)

    expect(new Set(seen)).toEqual(new Set([LATEST.id, MIDDLE.id, EARLIEST.id]))
  })
})
