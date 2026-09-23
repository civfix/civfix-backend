/**
 * Schema integration test (Docker-gated): migration 0048_chat_polls.sql against a live PostGIS
 * container (via withPg), in raw SQL. Verifies the things only a real postgres can prove:
 *
 *   - the chat_polls / chat_poll_options / chat_poll_votes trio exists with sensible defaults;
 *   - the vote composite FK rejects a vote whose (poll_id, option_idx) has no matching option row;
 *   - deleting an OPTION cascades away only that option's votes;
 *   - deleting the POLL cascades away its options AND all remaining votes.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"

const pg = await withPg()

describe.skipIf(!pg)("chat polls schema (0048, integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  /**
   * Seed a poll with `optionCount` options. message_id is a bare uuid (no chat_messages row needed:
   * the table has no FK to the partitioned parent, by design). Returns the poll's message_id.
   */
  async function newPoll(optionCount: number): Promise<string> {
    const creatorId = await newUser("Poll creator")
    const [p] = await h.sql<{ message_id: string }[]>`
      INSERT INTO chat_polls (message_id, question, created_by)
      VALUES (gen_random_uuid(), 'Favourite cleanup day?', ${creatorId})
      RETURNING message_id
    `
    const pollId = p!.message_id
    for (let idx = 0; idx < optionCount; idx++) {
      await h.sql`
        INSERT INTO chat_poll_options (poll_id, idx, text)
        VALUES (${pollId}, ${idx}, ${"Option " + idx})
      `
    }
    return pollId
  }

  async function voteCount(pollId: string): Promise<number> {
    const [r] = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat_poll_votes WHERE poll_id = ${pollId}
    `
    return r!.n
  }

  async function optionCount(pollId: string): Promise<number> {
    const [r] = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat_poll_options WHERE poll_id = ${pollId}
    `
    return r!.n
  }

  it("creates the poll trio with sensible defaults", async () => {
    const pollId = await newPoll(2)
    const [p] = await h.sql<
      { allow_multiple: boolean; anonymous: boolean; closed_at: string | null }[]
    >`
      SELECT allow_multiple, anonymous, closed_at FROM chat_polls WHERE message_id = ${pollId}
    `
    expect(p).toEqual({ allow_multiple: false, anonymous: true, closed_at: null })
  })

  it("rejects a vote for an option_idx with no matching option row (composite FK)", async () => {
    const pollId = await newPoll(2) // options idx 0,1 exist
    const voterId = await newUser("Bad-idx voter")
    await expect(
      h.sql`
        INSERT INTO chat_poll_votes (poll_id, option_idx, user_id)
        VALUES (${pollId}, 9, ${voterId})
      `,
    ).rejects.toThrow()

    // A vote for a real option succeeds.
    const [v] = await h.sql<{ option_idx: number }[]>`
      INSERT INTO chat_poll_votes (poll_id, option_idx, user_id)
      VALUES (${pollId}, 1, ${voterId})
      RETURNING option_idx
    `
    expect(v!.option_idx).toBe(1)
  })

  it("deleting an option cascades away only that option's votes", async () => {
    const pollId = await newPoll(2)
    const voterA = await newUser("Voter A")
    const voterB = await newUser("Voter B")
    // A votes option 0, B votes option 1.
    await h.sql`INSERT INTO chat_poll_votes (poll_id, option_idx, user_id) VALUES (${pollId}, 0, ${voterA})`
    await h.sql`INSERT INTO chat_poll_votes (poll_id, option_idx, user_id) VALUES (${pollId}, 1, ${voterB})`
    expect(await voteCount(pollId)).toBe(2)

    // Drop option 0 -> its one vote cascades; option 1's vote survives.
    await h.sql`DELETE FROM chat_poll_options WHERE poll_id = ${pollId} AND idx = 0`
    expect(await optionCount(pollId)).toBe(1)
    expect(await voteCount(pollId)).toBe(1)
    const [surviving] = await h.sql<{ option_idx: number }[]>`
      SELECT option_idx FROM chat_poll_votes WHERE poll_id = ${pollId}
    `
    expect(surviving!.option_idx).toBe(1)
  })

  it("deleting the poll cascades away its options and all remaining votes", async () => {
    const pollId = await newPoll(3)
    const voter = await newUser("Poll-delete voter")
    await h.sql`INSERT INTO chat_poll_votes (poll_id, option_idx, user_id) VALUES (${pollId}, 0, ${voter})`
    await h.sql`INSERT INTO chat_poll_votes (poll_id, option_idx, user_id) VALUES (${pollId}, 2, ${voter})`
    expect(await optionCount(pollId)).toBe(3)
    expect(await voteCount(pollId)).toBe(2)

    await h.sql`DELETE FROM chat_polls WHERE message_id = ${pollId}`
    expect(await optionCount(pollId)).toBe(0)
    expect(await voteCount(pollId)).toBe(0)
  })
})
