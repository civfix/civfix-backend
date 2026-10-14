// Follower/following pages key on the edge's created_at (indexed, drizzle/0093) and sort by name only
// within the fetched page; sorting the whole edge set by display_name was O(edges log edges) per page.
// The oldest edge is deliberately named "Aaron" so a name-ordered implementation would put it on page 1,
// and a same-timestamp boundary catches a keyset that ignores the id tiebreak.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, seedFollowEdge, testHandle, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleSocialRepository } from "../../src/services/social-repository.drizzle.js"
import type { SocialRepository } from "../../src/services/social-repository.js"

const pg = await withPg()

describe.skipIf(!pg)("F158: connections pages key on the follow edge, not display_name", () => {
  let h: PgHarness
  let repo: SocialRepository
  let target: string

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleSocialRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`DELETE FROM follows_people`
    await h.sql`UPDATE users SET follower_count = 0, following_count = 0`
    target = await newUser("Target")
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${testHandle()}) RETURNING id
    `
    return u!.id
  }

  async function walk(limit: number): Promise<string[]> {
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 20; page++) {
      const res: { items: Array<{ id: string }>; nextCursor: string | null } =
        await repo.listFollowers({ id: target, viewerId: null, cursor, limit })
      seen.push(...res.items.map((i) => i.id))
      if (res.nextCursor === null) return seen
      cursor = res.nextCursor
    }
    throw new Error("cursor never terminated")
  }

  it("returns the NEWEST edges first, regardless of the follower's display name", async () => {
    const oldestButAlphabeticallyFirst = await newUser("Aaron")
    const middle = await newUser("Mallory")
    const newest = await newUser("Zoe")
    await seedFollowEdge(
      h.sql,
      oldestButAlphabeticallyFirst,
      target,
      new Date("2026-01-01T00:00:00Z"),
    )
    await seedFollowEdge(h.sql, middle, target, new Date("2026-02-01T00:00:00Z"))
    await seedFollowEdge(h.sql, newest, target, new Date("2026-03-01T00:00:00Z"))

    const first = await repo.listFollowers({ id: target, viewerId: null, cursor: null, limit: 2 })
    expect(first.items.map((i) => i.id).sort()).toEqual([middle, newest].sort())
    expect(first.nextCursor).not.toBeNull()

    const second = await repo.listFollowers({
      id: target,
      viewerId: null,
      cursor: first.nextCursor,
      limit: 2,
    })
    expect(second.items.map((i) => i.id)).toEqual([oldestButAlphabeticallyFirst])
    expect(second.nextCursor).toBeNull()
  })

  it("walks every follower exactly once across pages, with no skip and no duplicate", async () => {
    const followers: string[] = []
    for (let i = 0; i < 7; i++) {
      const id = await newUser(`Follower ${i}`)
      followers.push(id)
      await seedFollowEdge(h.sql, id, target, new Date(Date.UTC(2026, 0, 1 + i)))
    }

    const seen = await walk(2)
    expect(seen).toHaveLength(followers.length)
    expect(new Set(seen).size).toBe(followers.length)
    expect(seen.slice().sort()).toEqual(followers.slice().sort())
  })

  it("does not lose a follower at a SAME-TIMESTAMP page boundary", async () => {
    const sameMs = new Date("2026-04-04T04:04:04.000Z")
    const tied: string[] = []
    for (let i = 0; i < 4; i++) {
      const id = await newUser(`Tied ${i}`)
      tied.push(id)
      await seedFollowEdge(h.sql, id, target, sameMs)
    }

    const seen = await walk(2)
    expect(new Set(seen).size).toBe(tied.length)
    expect(seen.slice().sort()).toEqual(tied.slice().sort())
  })

  it("sorts the members WITHIN a page by display name", async () => {
    const zoe = await newUser("Zoe")
    const aaron = await newUser("Aaron")
    const sameMs = new Date("2026-05-05T05:05:05.000Z")
    await seedFollowEdge(h.sql, zoe, target, sameMs)
    await seedFollowEdge(h.sql, aaron, target, sameMs)

    const page = await repo.listFollowers({ id: target, viewerId: null, cursor: null, limit: 10 })
    expect(page.items.map((i) => i.displayName)).toEqual(["Aaron", "Zoe"])
  })
})
