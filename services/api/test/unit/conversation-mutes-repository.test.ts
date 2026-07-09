import { describe, it, expect } from "vitest"
import type { Sql } from "../../src/db/client.js"
import { makeConversationMutesRepository } from "../../src/services/conversation-mutes-repository.drizzle.js"

/**
 * DB-free unit test for the mutedRoomIdsFor empty-input short-circuit: no database is needed because
 * an empty roomIds array must never reach `sql` at all. The `sql` stub throws if invoked, so this test
 * would fail loudly if the guard were ever removed. Every other repo method touches the DB and is
 * covered by the Docker-gated integration path instead.
 */

function makeThrowingSql(): Sql {
  const fn = () => {
    throw new Error("sql should not be called for an empty roomIds batch")
  }
  return fn as unknown as Sql
}

describe("makeConversationMutesRepository.mutedRoomIdsFor", () => {
  it("returns an empty Set with NO query when roomIds is empty", async () => {
    const repo = makeConversationMutesRepository(makeThrowingSql())
    const result = await repo.mutedRoomIdsFor("user-1", "report", [])
    expect(result).toEqual(new Set())
  })
})
