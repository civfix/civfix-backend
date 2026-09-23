import { describe, expect, it } from "vitest"
import type { Sql } from "../../src/db/client.js"
import {
  resolveHandles,
  resolveUserIdsToMentions,
  resolveMentionTargets,
} from "../../src/services/social-repository.drizzle.js"

const AUTHOR = "22222222-2222-2222-2222-222222222222"
const ALICE = "44444444-4444-4444-4444-444444444444"
const BOB = "55555555-5555-5555-5555-555555555555"

function fakeSql(rows: unknown[]): Sql {
  const tag = (() => Promise.resolve(rows)) as unknown as Sql
  return new Proxy(tag, {
    apply: (target, _thisArg, args) => {
      if (Array.isArray(args[0]) && "raw" in (args[0] as object)) return Promise.resolve(rows)
      return { __fragment: true }
    },
  }) as Sql
}

describe("resolveHandles", () => {
  it("short-circuits to [] on empty input (no DB call)", async () => {
    const result = await resolveHandles(null as unknown as Sql, [], AUTHOR)
    expect(result).toEqual([])
  })

  it("projects rows into UserMentionDTO", async () => {
    const sql = fakeSql([
      { id: ALICE, handle: "alice", display_name: "Alice A" },
      { id: BOB, handle: "bob", display_name: "Bob B" },
    ])
    const result = await resolveHandles(sql, ["alice", "bob"], AUTHOR)
    expect(result).toEqual([
      { id: ALICE, handle: "alice", displayName: "Alice A" },
      { id: BOB, handle: "bob", displayName: "Bob B" },
    ])
  })
})

describe("resolveUserIdsToMentions", () => {
  it("short-circuits to [] on empty input", async () => {
    expect(await resolveUserIdsToMentions(null as unknown as Sql, [], AUTHOR)).toEqual([])
  })

  it("drops non-UUID ids and projects the rest", async () => {
    const sql = fakeSql([{ id: ALICE, handle: "alice", display_name: "Alice A" }])
    const result = await resolveUserIdsToMentions(sql, ["not-a-uuid", ALICE], AUTHOR)
    expect(result).toEqual([{ id: ALICE, handle: "alice", displayName: "Alice A" }])
  })

  it("short-circuits when every id is malformed (no DB call)", async () => {
    expect(await resolveUserIdsToMentions(null as unknown as Sql, ["nope"], AUTHOR)).toEqual([])
  })
})

describe("resolveMentionTargets", () => {
  it("de-dupes a user resolved by BOTH handle and id (handle wins order)", async () => {
    const sql = fakeSql([{ id: ALICE, handle: "alice", display_name: "Alice A" }])
    const result = await resolveMentionTargets(sql, {
      handles: ["alice"],
      userIds: [ALICE],
      authorUserId: AUTHOR,
    })
    expect(result).toEqual([{ id: ALICE, handle: "alice", displayName: "Alice A" }])
  })
})
