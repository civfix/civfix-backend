/**
 * Tests for the offline threads repository in test/helpers/chat.ts.
 *
 * threads-service pushes its inbox keyset cursor into EVERY thread family and then re-filters the merged
 * page with the identical (activity, id) predicate, trusting each family not to re-offer rows the caller
 * already saw. This fake used to accept `(userId, limit)` and drop the cursor entirely, so page 2 of an
 * offline inbox re-returned page 1's newest rows, the service's exact filter discarded them, and the page
 * came back short: invisible in a single-page test, wrong the moment pagination is exercised.
 *
 * The order under test is the Drizzle repository's: activity = COALESCE(last message created_at,
 * joined_at) DESC, then room id DESC.
 */

import { describe, expect, it } from "vitest"
import { InMemoryThreadsRepository } from "./chat.js"
import { encodeTimeCursor, parseTimeCursor, type TimeCursor } from "../../src/db/cursor-helpers.js"

const VIEWER = "viewer-1"
const OTHER = "other-1"

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const C = "cccccccc-cccc-cccc-cccc-cccccccccccc"

const T1 = new Date("2026-07-01T00:00:00.000Z")
const T2 = new Date("2026-07-02T00:00:00.000Z")
const T3 = new Date("2026-07-03T00:00:00.000Z")

/** Three rooms the viewer is in, with last-message times T3 (A) > T2 (B) > T1 (C). */
function seedThree(): InMemoryThreadsRepository {
  const repo = new InMemoryThreadsRepository()
  for (const [id, at] of [
    [A, T3],
    [B, T2],
    [C, T1],
  ] as const) {
    repo.seedCleanup(`room ${id.slice(0, 1)}`, id)
    repo.addMember(id, VIEWER, new Date("2026-01-01T00:00:00.000Z"))
    repo.addMessage(id, { senderId: OTHER, body: "hi", createdAt: at })
  }
  return repo
}

const ids = (rows: { cleanupId: string }[]): string[] => rows.map((r) => r.cleanupId)

describe("InMemoryThreadsRepository.listThreadsFor: ordering + membership", () => {
  it("returns the viewer's rooms newest-activity first and caps at limit", async () => {
    const repo = seedThree()
    expect(ids(await repo.listThreadsFor(VIEWER, 10))).toEqual([A, B, C])
    expect(ids(await repo.listThreadsFor(VIEWER, 2))).toEqual([A, B])
  })

  it("never returns a room the viewer is not a member of", async () => {
    const repo = seedThree()
    repo.seedCleanup("stranger room", "dddddddd-dddd-dddd-dddd-dddddddddddd")
    repo.addMember("dddddddd-dddd-dddd-dddd-dddddddddddd", OTHER)
    expect(ids(await repo.listThreadsFor(VIEWER, 10))).toEqual([A, B, C])
  })

  it("falls back to joined_at as the activity for a room with no messages", async () => {
    const repo = seedThree()
    // Joined AFTER every existing last-message instant -> sorts first despite having no messages.
    const empty = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
    repo.seedCleanup("empty", empty)
    repo.addMember(empty, VIEWER, new Date("2026-07-04T00:00:00.000Z"))
    const rows = await repo.listThreadsFor(VIEWER, 10)
    expect(ids(rows)).toEqual([empty, A, B, C])
    expect(rows[0]!.last).toBeNull()
  })
})

describe("InMemoryThreadsRepository.listThreadsFor: keyset cursor (D11)", () => {
  it("pages forward without repeating or skipping a row", async () => {
    const repo = seedThree()
    const page1 = await repo.listThreadsFor(VIEWER, 2)
    expect(ids(page1)).toEqual([A, B])

    // The cursor the service would derive from the last emitted row.
    const cursor = parseTimeCursor(encodeTimeCursor({ at: T2, id: B }))
    const page2 = await repo.listThreadsFor(VIEWER, 2, cursor)
    // Ignoring the cursor would return [A, B] again here.
    expect(ids(page2)).toEqual([C])
  })

  it("applies the limit AFTER the cursor filter", async () => {
    const repo = seedThree()
    const cursor: TimeCursor = { at: T3, id: A }
    expect(ids(await repo.listThreadsFor(VIEWER, 1, cursor))).toEqual([B])
  })

  it("excludes the cursor's own row (strictly before, never inclusive)", async () => {
    const repo = seedThree()
    const cursor: TimeCursor = { at: T1, id: C }
    expect(await repo.listThreadsFor(VIEWER, 10, cursor)).toEqual([])
  })

  it("breaks an activity tie by id DESC, so a tied page boundary loses no row", async () => {
    const repo = new InMemoryThreadsRepository()
    const tie = new Date("2026-07-05T00:00:00.000Z")
    for (const id of [A, B, C]) {
      repo.seedCleanup(`tied ${id.slice(0, 1)}`, id)
      repo.addMember(id, VIEWER)
      repo.addMessage(id, { senderId: OTHER, body: "tied", createdAt: tie })
    }
    // All three share one instant: id DESC orders them C, B, A.
    expect(ids(await repo.listThreadsFor(VIEWER, 3))).toEqual([C, B, A])
    // Walking one row at a time must visit each exactly once (a created_at-only cursor would either
    // re-emit the tied rows forever or skip two of them).
    const seen: string[] = []
    let cursor: TimeCursor | null = null
    for (let guard = 0; guard < 5; guard++) {
      const page: { cleanupId: string; last: { createdAt: Date } | null; joinedAt: Date }[] =
        await repo.listThreadsFor(VIEWER, 1, cursor)
      if (page.length === 0) break
      const row = page[0]!
      seen.push(row.cleanupId)
      cursor = { at: row.last?.createdAt ?? row.joinedAt, id: row.cleanupId }
    }
    expect(seen).toEqual([C, B, A])
  })

  it("treats null / undefined / a malformed cursor as page one", async () => {
    const repo = seedThree()
    const all = [A, B, C]
    expect(ids(await repo.listThreadsFor(VIEWER, 10, null))).toEqual(all)
    expect(ids(await repo.listThreadsFor(VIEWER, 10, undefined))).toEqual(all)
    // parseTimeCursor degrades a malformed cursor to null (never a throw), and the repo must then page
    // from the start rather than filtering everything out.
    expect(ids(await repo.listThreadsFor(VIEWER, 10, parseTimeCursor("garbage")))).toEqual(all)
  })

  it("filters a message-less room by its joined_at, like the SQL's COALESCE", async () => {
    const repo = seedThree()
    const empty = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
    repo.seedCleanup("empty", empty)
    repo.addMember(empty, VIEWER, T2) // same instant as room B's last message
    // Cursor at that instant with id = empty: B (id "bbbb..." < "eeee...") survives, the empty room does not.
    const cursor: TimeCursor = { at: T2, id: empty }
    expect(ids(await repo.listThreadsFor(VIEWER, 10, cursor))).toEqual([B, C])
  })
})
