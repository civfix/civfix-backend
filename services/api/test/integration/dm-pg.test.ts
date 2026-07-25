/**
 * Direct-messages integration test (Docker-gated). Boots against a live PostGIS container (via withPg)
 * and exercises the DB-backed DM paths the offline suite covers only with in-memory fakes:
 *
 *   - the Drizzle DmRepository openOrCreateThread is idempotent (one thread per unordered pair) and orders
 *     the participants lo<hi;
 *   - persist lands in the PARTITIONED dm_messages table and history pages newest-first with a cursor;
 *   - the dm read watermark (dm_read_state) is monotonic;
 *   - countUnread (what openDm reports) counts only the PEER's live messages after the watermark, and
 *     agrees with the unread the inbox aggregate computes for the same thread;
 *   - user_blocks: block is idempotent, isBlockedEitherWay is bidirectional, listBlocked projects PersonDTOs;
 *   - searchByHandlePrefix excludes self / no-handle / DM-off / soft-deleted / blocked-either-way;
 *   - listThreadsForUser (the threads UNION's DM half) includes a dm thread and excludes a blocked one.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { makeDrizzleDmRepository } from "../../src/services/dm-repository.drizzle.js"
import { makeDrizzleBlocksRepository } from "../../src/services/blocks-repository.drizzle.js"
import { searchByHandlePrefix } from "../../src/services/social-repository.drizzle.js"

const pg = await withPg()

describe.skipIf(!pg)("direct messages (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  /** Insert a user (optionally with a handle / DM toggle) and return its id. */
  async function newUser(
    name: string,
    opts: { handle?: string; allowDm?: boolean; deleted?: boolean } = {},
  ): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, allow_direct_messages, deleted_at)
      VALUES (
        ${name},
        ${opts.handle ?? testHandle()},
        ${opts.allowDm ?? true},
        ${opts.deleted ? new Date() : null}
      )
      RETURNING id
    `
    return u!.id
  }

  it("openOrCreateThread is idempotent and orders the pair lo<hi", async () => {
    const a = await newUser("DM A")
    const b = await newUser("DM B")
    const repo = makeDrizzleDmRepository(h.sql)

    const t1 = await repo.openOrCreateThread(a, b)
    const t2 = await repo.openOrCreateThread(b, a) // reverse order, same pair
    expect(t2.id).toBe(t1.id)
    expect(t1.userLo < t1.userHi).toBe(true)

    // Both users are participants; a stranger is not.
    expect(await repo.isParticipant(t1.id, a)).toBe(true)
    expect(await repo.isParticipant(t1.id, b)).toBe(true)
    const stranger = await newUser("DM Stranger")
    expect(await repo.isParticipant(t1.id, stranger)).toBe(false)

    // getThreadForPair finds it without creating; a never-paired set returns null.
    expect((await repo.getThreadForPair(a, b))?.id).toBe(t1.id)
    expect(await repo.getThreadForPair(a, stranger)).toBeNull()
  })

  it("persists into the partitioned dm_messages table and pages history newest-first", async () => {
    const a = await newUser("DM Hist A")
    const b = await newUser("DM Hist B")
    const repo = makeDrizzleDmRepository(h.sql)
    const thread = await repo.openOrCreateThread(a, b)

    const ids: string[] = []
    for (let i = 1; i <= 5; i++) {
      const dto = await repo.persist({ threadId: thread.id, senderId: a, body: `m${i}` })
      expect(dto.roomKind).toBe("dm")
      expect(dto.cleanupId).toBe(thread.id)
      // DM messages always have an author (no sender-less SYSTEM messages on the dm path); assert that
      // before narrowing so the intent (author == a) stays explicit.
      expect(dto.from).toBeTruthy()
      expect(dto.from?.id).toBe(a)
      ids.push(dto.id)
    }
    // Force strictly-increasing created_at (back-to-back inserts can tie now()).
    const base = Date.now()
    let order = 0
    for (const id of ids) {
      await h.sql`UPDATE dm_messages SET created_at = ${new Date(base + order * 1000)} WHERE id = ${id}`
      order++
    }

    const page1 = await repo.history(thread.id, undefined, 2)
    expect(page1.items.map((m) => m.body)).toEqual(["m5", "m4"])
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await repo.history(thread.id, page1.nextCursor!, 2)
    expect(page2.items.map((m) => m.body)).toEqual(["m3", "m2"])
    const page3 = await repo.history(thread.id, page2.nextCursor!, 2)
    expect(page3.items.map((m) => m.body)).toEqual(["m1"])
    expect(page3.nextCursor).toBeNull()

    // The rows physically landed in a monthly partition (not just the parent).
    const partition = await h.sql<{ child: string }[]>`
      SELECT tableoid::regclass::text AS child FROM dm_messages WHERE thread_id = ${thread.id} LIMIT 1
    `
    expect(partition[0]!.child).toContain("dm_messages_")
  })

  it("persists the dm read watermark monotonically", async () => {
    const a = await newUser("DM Read A")
    const b = await newUser("DM Read B")
    const repo = makeDrizzleDmRepository(h.sql)
    const thread = await repo.openOrCreateThread(a, b)

    expect(await repo.lastReadAt(thread.id, a)).toBeNull()
    const t1 = new Date("2026-06-01T12:00:00.000Z")
    await repo.markRead(thread.id, a, t1)
    expect((await repo.lastReadAt(thread.id, a))!.getTime()).toBe(t1.getTime())
    // An EARLIER mark never moves it back.
    await repo.markRead(thread.id, a, new Date("2026-06-01T11:00:00.000Z"))
    expect((await repo.lastReadAt(thread.id, a))!.getTime()).toBe(t1.getTime())
    // A LATER mark advances it.
    const t2 = new Date("2026-06-01T13:00:00.000Z")
    await repo.markRead(thread.id, a, t2)
    expect((await repo.lastReadAt(thread.id, a))!.getTime()).toBe(t2.getTime())
  })

  it("countUnread agrees with the inbox aggregate: peer-only, watermarked, tombstone-aware", async () => {
    const a = await newUser("DM Unread A")
    const b = await newUser("DM Unread B")
    const repo = makeDrizzleDmRepository(h.sql)
    const thread = await repo.openOrCreateThread(a, b)

    // Never read + no messages: zero.
    expect(await repo.countUnread(thread.id, a)).toBe(0)

    const first = await repo.persist({ threadId: thread.id, senderId: b, body: "yo" })
    await repo.persist({ threadId: thread.id, senderId: b, body: "you there?" })
    await repo.persist({ threadId: thread.id, senderId: a, body: "hi" })

    // Only the PEER's live messages count, for each side of the thread...
    expect(await repo.countUnread(thread.id, a)).toBe(2)
    expect(await repo.countUnread(thread.id, b)).toBe(1)
    // ...and this is the same number the inbox row shows (single-sourced predicate — openDm reporting a
    // different unread than the threads list would be the bug this method exists to prevent).
    const inbox = await repo.listThreadsForUser(a)
    expect(inbox.find((t) => t.threadId === thread.id)!.unread).toBe(2)

    // A tombstoned message stops counting.
    await h.sql`UPDATE dm_messages SET deleted_at = now() WHERE id = ${first.id}`
    expect(await repo.countUnread(thread.id, a)).toBe(1)

    // The watermark clears the rest (dm_read_state, the same row markRead advances). The watermark is
    // taken from the DATABASE clock, not this process's: created_at is written by the server (now()), and
    // the ack path likewise resolves a real message's created_at rather than trusting a client timestamp,
    // so comparing against a host-side `new Date()` would be at the mercy of container clock skew.
    const [clock] = await h.sql<{ at: Date }[]>`SELECT now() AS at`
    await repo.markRead(thread.id, a, clock!.at)
    expect(await repo.countUnread(thread.id, a)).toBe(0)
    // A message after the watermark counts again.
    await repo.persist({ threadId: thread.id, senderId: b, body: "still there?" })
    expect(await repo.countUnread(thread.id, a)).toBe(1)
  })

  it("user_blocks: block idempotent, isBlockedEitherWay bidirectional, listBlocked projects PersonDTOs", async () => {
    const a = await newUser("Blk A")
    const b = await newUser("Blk B", { handle: `blkb_${randomUUID().slice(0, 8)}` })
    const repo = makeDrizzleBlocksRepository(h.sql)

    expect(await repo.isBlockedEitherWay(a, b)).toBe(false)
    await repo.block(a, b)
    await repo.block(a, b) // idempotent (no throw)
    expect(await repo.isBlockedEitherWay(a, b)).toBe(true)
    expect(await repo.isBlockedEitherWay(b, a)).toBe(true)

    const list = await repo.listBlocked(a)
    expect(list.map((p) => p.id)).toContain(b)

    await repo.unblock(a, b)
    expect(await repo.isBlockedEitherWay(a, b)).toBe(false)
  })

  it("searchByHandlePrefix excludes self / no-handle / DM-off / deleted / blocked-either-way", async () => {
    const tag = randomUUID().slice(0, 8)
    const viewer = await newUser("Searcher", { handle: `searcher_${tag}` })
    const match = await newUser("Match", { handle: `zz${tag}_match` })
    const dmOff = await newUser("DM Off", { handle: `zz${tag}_dmoff`, allowDm: false })
    const deleted = await newUser("Gone", { handle: `zz${tag}_gone`, deleted: true })
    const noHandle = await newUser("No Handle") // null handle
    const blocked = await newUser("Blocked", { handle: `zz${tag}_blocked` })
    await makeDrizzleBlocksRepository(h.sql).block(blocked, viewer) // blocked blocked the viewer

    const results = await searchByHandlePrefix(h.sql, `zz${tag}_`, viewer, 20)
    const ids = new Set(results.map((r) => r.id))
    expect(ids.has(match)).toBe(true)
    expect(ids.has(dmOff)).toBe(false)
    expect(ids.has(deleted)).toBe(false)
    expect(ids.has(noHandle)).toBe(false)
    expect(ids.has(blocked)).toBe(false)
    expect(ids.has(viewer)).toBe(false)
    // The result DTO is minimal (no email/bio/follower fields).
    const hit = results.find((r) => r.id === match)!
    expect(hit.handle).toBe(`zz${tag}_match`)
    expect(hit).not.toHaveProperty("email")
    expect(hit).not.toHaveProperty("bio")
  })

  it("listThreadsForUser includes a dm thread and excludes one blocked either way", async () => {
    const a = await newUser("Union A", { handle: `unia_${randomUUID().slice(0, 8)}` })
    const b = await newUser("Union B", { handle: `unib_${randomUUID().slice(0, 8)}` })
    const c = await newUser("Union C", { handle: `unic_${randomUUID().slice(0, 8)}` })
    const dmRepo = makeDrizzleDmRepository(h.sql)
    const blocksRepo = makeDrizzleBlocksRepository(h.sql)

    const tAB = await dmRepo.openOrCreateThread(a, b)
    await dmRepo.persist({ threadId: tAB.id, senderId: b, body: "hi from b" })
    const tAC = await dmRepo.openOrCreateThread(a, c)
    await dmRepo.persist({ threadId: tAC.id, senderId: c, body: "hi from c" })

    // Before blocking: A sees both threads, each with the right peer + unread 1 (peer's message, unread).
    const before = await dmRepo.listThreadsForUser(a)
    const beforeIds = new Set(before.map((t) => t.threadId))
    expect(beforeIds.has(tAB.id)).toBe(true)
    expect(beforeIds.has(tAC.id)).toBe(true)
    const ab = before.find((t) => t.threadId === tAB.id)!
    expect(ab.peer.id).toBe(b)
    expect(ab.unread).toBe(1)
    expect(ab.last?.body).toBe("hi from b")

    // Block C -> the A-C thread is hidden from A's union.
    await blocksRepo.block(a, c)
    const after = await dmRepo.listThreadsForUser(a)
    const afterIds = new Set(after.map((t) => t.threadId))
    expect(afterIds.has(tAB.id)).toBe(true)
    expect(afterIds.has(tAC.id)).toBe(false)
  })
})
