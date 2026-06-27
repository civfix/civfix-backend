import { describe, it, expect, beforeEach } from "vitest"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import {
  makeThreadsService,
  InMemoryChatReadState,
  type DmThreadsSource,
} from "../../src/services/threads-service.js"
import { InMemoryThreadsRepository } from "../helpers/chat.js"

/**
 * In-memory blocks repo behavior + the threads UNION (cleanup + dm) merge.
 */

const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"
const CAROL = "33333333-3333-3333-3333-333333333333"

describe("InMemoryBlocksRepository", () => {
  let blocks: InMemoryBlocksRepository
  beforeEach(() => {
    blocks = new InMemoryBlocksRepository()
    blocks.registerUser({ id: BOB, displayName: "Bob", handle: "bob" })
  })

  it("block is idempotent and isBlockedEitherWay is bidirectional", async () => {
    expect(await blocks.isBlockedEitherWay(ALICE, BOB)).toBe(false)
    await blocks.block(ALICE, BOB)
    await blocks.block(ALICE, BOB) // idempotent
    // Bidirectional: true whether queried (a,b) or (b,a).
    expect(await blocks.isBlockedEitherWay(ALICE, BOB)).toBe(true)
    expect(await blocks.isBlockedEitherWay(BOB, ALICE)).toBe(true)
    // The other direction also counts as blocked-either-way.
    await blocks.unblock(ALICE, BOB)
    expect(await blocks.isBlockedEitherWay(ALICE, BOB)).toBe(false)
    await blocks.block(BOB, ALICE)
    expect(await blocks.isBlockedEitherWay(ALICE, BOB)).toBe(true)
  })

  it("listBlocked returns the viewer's blocked users as PersonDTOs", async () => {
    await blocks.block(ALICE, BOB)
    const list = await blocks.listBlocked(ALICE)
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(BOB)
    expect(list[0]!.name).toBe("Bob")
  })
})

describe("threads UNION (cleanup + dm)", () => {
  let cleanupRepo: InMemoryThreadsRepository
  let dmRepo: InMemoryDmRepository
  let blocks: InMemoryBlocksRepository

  beforeEach(() => {
    cleanupRepo = new InMemoryThreadsRepository()
    blocks = new InMemoryBlocksRepository()
    dmRepo = new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
    dmRepo.registerUser({ id: BOB, displayName: "Bob", handle: "bob" })
    dmRepo.registerUser({ id: CAROL, displayName: "Carol", handle: "carol" })
  })

  function dmSource(): DmThreadsSource {
    return { listDmThreadsFor: (userId) => dmRepo.listThreadsForUser(userId) }
  }

  it("merges a cleanup thread and a dm thread, most-recent-activity first", async () => {
    // A cleanup the viewer joined, with an OLDER message (the in-memory dm repo stamps its synthetic clock
    // at 2026-01-01+, so the cleanup message must predate that to sort after the dm thread below).
    const cleanupId = cleanupRepo.seedCleanup("Beach Sweep")
    cleanupRepo.addMember(cleanupId, ALICE, new Date("2025-12-01T09:00:00.000Z"))
    cleanupRepo.addMessage(cleanupId, {
      senderId: BOB,
      body: "bring gloves",
      createdAt: new Date("2025-12-01T10:00:00.000Z"),
    })

    // A dm thread with a MORE RECENT message (so it should sort first).
    const thread = await dmRepo.openOrCreateThread(ALICE, CAROL)
    await dmRepo.persist({ threadId: thread.id, senderId: CAROL, body: "hi alice" })

    const svc = makeThreadsService({
      repo: cleanupRepo,
      readState: new InMemoryChatReadState(),
      dm: dmSource(),
      now: () => new Date("2026-06-07T12:00:00.000Z"),
    })
    const { items } = await svc.listThreads(ALICE, 30)
    expect(items).toHaveLength(2)
    // The dm thread (newer activity) sorts first; it carries kind:"dm", peer + display-name title + unread 1.
    expect(items[0]!.kind).toBe("dm")
    expect(items[0]!.title).toBe("Carol")
    expect(items[0]!.peer?.id).toBe(CAROL)
    expect(items[0]!.unread).toBe(1)
    expect(items[1]!.kind).toBe("cleanup")
    expect(items[1]!.title).toBe("Beach Sweep")
  })

  it("excludes a dm thread that is blocked either way", async () => {
    const thread = await dmRepo.openOrCreateThread(ALICE, CAROL)
    await dmRepo.persist({ threadId: thread.id, senderId: CAROL, body: "hello" })
    // Block Carol -> the dm thread is hidden from BOTH sides' inbox.
    await blocks.block(ALICE, CAROL)

    const svc = makeThreadsService({
      repo: cleanupRepo,
      readState: new InMemoryChatReadState(),
      dm: dmSource(),
    })
    expect((await svc.listThreads(ALICE, 30)).items).toHaveLength(0)
    expect((await svc.listThreads(CAROL, 30)).items).toHaveLength(0)
  })
})
