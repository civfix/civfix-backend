
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { DELETED_USER_LABEL } from "@civfix/shared"
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
    const t2 = await repo.openOrCreateThread(b, a)
    expect(t2.id).toBe(t1.id)
    expect(t1.userLo < t1.userHi).toBe(true)

    expect(await repo.isParticipant(t1.id, a)).toBe(true)
    expect(await repo.isParticipant(t1.id, b)).toBe(true)
    const stranger = await newUser("DM Stranger")
    expect(await repo.isParticipant(t1.id, stranger)).toBe(false)

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
      expect(dto.from).toBeTruthy()
      expect(dto.from?.id).toBe(a)
      ids.push(dto.id)
    }
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
    await repo.markRead(thread.id, a, new Date("2026-06-01T11:00:00.000Z"))
    expect((await repo.lastReadAt(thread.id, a))!.getTime()).toBe(t1.getTime())
    const t2 = new Date("2026-06-01T13:00:00.000Z")
    await repo.markRead(thread.id, a, t2)
    expect((await repo.lastReadAt(thread.id, a))!.getTime()).toBe(t2.getTime())
  })

  it("countUnread agrees with the inbox aggregate: peer-only, watermarked, tombstone-aware", async () => {
    const a = await newUser("DM Unread A")
    const b = await newUser("DM Unread B")
    const repo = makeDrizzleDmRepository(h.sql)
    const thread = await repo.openOrCreateThread(a, b)

    expect(await repo.countUnread(thread.id, a)).toBe(0)

    const first = await repo.persist({ threadId: thread.id, senderId: b, body: "yo" })
    await repo.persist({ threadId: thread.id, senderId: b, body: "you there?" })
    await repo.persist({ threadId: thread.id, senderId: a, body: "hi" })

    expect(await repo.countUnread(thread.id, a)).toBe(2)
    expect(await repo.countUnread(thread.id, b)).toBe(1)
    const inbox = await repo.listThreadsForUser(a)
    expect(inbox.find((t) => t.threadId === thread.id)!.unread).toBe(2)

    await h.sql`UPDATE dm_messages SET deleted_at = now() WHERE id = ${first.id}`
    expect(await repo.countUnread(thread.id, a)).toBe(1)

    const [clock] = await h.sql<{ at: Date }[]>`SELECT now() AS at`
    await repo.markRead(thread.id, a, clock!.at)
    expect(await repo.countUnread(thread.id, a)).toBe(0)
    await repo.persist({ threadId: thread.id, senderId: b, body: "still there?" })
    expect(await repo.countUnread(thread.id, a)).toBe(1)
  })

  it("user_blocks: block idempotent, isBlockedEitherWay bidirectional, listBlocked projects PersonDTOs", async () => {
    const a = await newUser("Blk A")
    const b = await newUser("Blk B", { handle: `blkb_${randomUUID().slice(0, 8)}` })
    const repo = makeDrizzleBlocksRepository(h.sql)

    expect(await repo.isBlockedEitherWay(a, b)).toBe(false)
    await repo.block(a, b)
    await repo.block(a, b)
    expect(await repo.isBlockedEitherWay(a, b)).toBe(true)
    expect(await repo.isBlockedEitherWay(b, a)).toBe(true)

    const { blocked } = await repo.listBlocked(a)
    expect(blocked.map((p) => p.id)).toContain(b)

    await repo.unblock(a, b)
    expect(await repo.isBlockedEitherWay(a, b)).toBe(false)
  })

  it("searchByHandlePrefix excludes self / no-handle / DM-off / deleted / blocked-either-way", async () => {
    const tag = randomUUID().slice(0, 8)
    const viewer = await newUser("Searcher", { handle: `searcher_${tag}` })
    const match = await newUser("Match", { handle: `zz${tag}_match` })
    const dmOff = await newUser("DM Off", { handle: `zz${tag}_dmoff`, allowDm: false })
    const deleted = await newUser("Gone", { handle: `zz${tag}_gone`, deleted: true })
    const noHandle = await newUser("No Handle")
    const blocked = await newUser("Blocked", { handle: `zz${tag}_blocked` })
    await makeDrizzleBlocksRepository(h.sql).block(blocked, viewer)

    const results = await searchByHandlePrefix(h.sql, `zz${tag}_`, viewer, 20)
    const ids = new Set(results.map((r) => r.id))
    expect(ids.has(match)).toBe(true)
    expect(ids.has(dmOff)).toBe(false)
    expect(ids.has(deleted)).toBe(false)
    expect(ids.has(noHandle)).toBe(false)
    expect(ids.has(blocked)).toBe(false)
    expect(ids.has(viewer)).toBe(false)
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

    const before = await dmRepo.listThreadsForUser(a)
    const beforeIds = new Set(before.map((t) => t.threadId))
    expect(beforeIds.has(tAB.id)).toBe(true)
    expect(beforeIds.has(tAC.id)).toBe(true)
    const ab = before.find((t) => t.threadId === tAB.id)!
    expect(ab.peer.id).toBe(b)
    expect(ab.unread).toBe(1)
    expect(ab.last?.body).toBe("hi from b")

    await blocksRepo.block(a, c)
    const after = await dmRepo.listThreadsForUser(a)
    const afterIds = new Set(after.map((t) => t.threadId))
    expect(afterIds.has(tAB.id)).toBe(true)
    expect(afterIds.has(tAC.id)).toBe(false)
  })

  it("keeps a thread in the inbox after the peer deletes their account, tombstoned as Deleted User", async () => {
    const a = await newUser("Survivor", { handle: `surv_${randomUUID().slice(0, 8)}` })
    const gone = await newUser("Leaver", { handle: `leaver_${randomUUID().slice(0, 8)}` })
    const dmRepo = makeDrizzleDmRepository(h.sql)

    const thread = await dmRepo.openOrCreateThread(a, gone)
    await dmRepo.persist({ threadId: thread.id, senderId: gone, body: "bye" })

    const before = await dmRepo.listThreadsForUser(a)
    const liveRow = before.find((t) => t.threadId === thread.id)!
    expect(liveRow.peer.deleted).toBe(false)
    expect(liveRow.peer.displayName).toBe("Leaver")
    expect(liveRow.unread).toBe(1)

    await h.sql`UPDATE users SET deleted_at = now() WHERE id = ${gone}`

    const after = await dmRepo.listThreadsForUser(a)
    const row = after.find((t) => t.threadId === thread.id)
    expect(row).toBeDefined()
    expect(row!.peer.id).toBe(gone)
    expect(row!.peer.deleted).toBe(true)
    expect(row!.peer.displayName).toBe(DELETED_USER_LABEL)
    expect(row!.peer.handle).toBeNull()
    expect(row!.peer.avatarUrl).toBeNull()
    expect(row!.peer.bio).toBeNull()
    expect(row!.unread).toBe(1)
    expect(row!.last?.body).toBe("bye")
  })
})
