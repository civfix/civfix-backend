import { describe, it, expect } from "vitest"
import { makeThreadsService, InMemoryChatReadState } from "../../src/services/threads-service.js"
import { makeMemoryConversationHidesRepository } from "../../src/services/conversation-hides-repository.memory.js"
import type { ConversationHidesRepository } from "../../src/services/conversation-hides-repository.drizzle.js"
import { InMemoryThreadsRepository } from "../helpers/chat.js"
import { InMemoryDmRepository } from "../../src/services/dm-repository.memory.js"

const ME = "11111111-1111-1111-1111-111111111111"
const OTHER = "22222222-2222-2222-2222-222222222222"
const NOW = new Date("2026-06-01T12:00:00.000Z")
const HIDDEN_AT = new Date("2026-06-01T11:00:00.000Z")

function seededRepo(hides?: ConversationHidesRepository): {
  repo: InMemoryThreadsRepository
  cleanupId: string
} {
  const repo = new InMemoryThreadsRepository(hides)
  const cleanupId = repo.seedCleanup("Beach sweep")
  repo.addMember(cleanupId, ME, new Date("2026-06-01T09:00:00.000Z"))
  repo.addMember(cleanupId, OTHER, new Date("2026-06-01T09:00:00.000Z"))
  repo.addMessage(cleanupId, {
    senderId: OTHER,
    body: "see you there",
    createdAt: new Date("2026-06-01T10:00:00.000Z"),
  })
  return { repo, cleanupId }
}

function service(repo: InMemoryThreadsRepository) {
  return makeThreadsService({ repo, readState: new InMemoryChatReadState(), now: () => NOW })
}

describe("threads list with per-user hides", () => {
  it("drops a hidden conversation from the hider's list only", async () => {
    const hides = makeMemoryConversationHidesRepository(() => HIDDEN_AT)
    const { repo, cleanupId } = seededRepo(hides)
    await hides.setHidden(ME, "cleanup", cleanupId, true)

    const svc = service(repo)
    expect((await svc.listThreads(ME)).items).toHaveLength(0)
    expect((await svc.listThreads(OTHER)).items.map((t) => t.id)).toEqual([cleanupId])
  })

  it("resurfaces the conversation when a message arrives after the hide", async () => {
    const hides = makeMemoryConversationHidesRepository(() => HIDDEN_AT)
    const { repo, cleanupId } = seededRepo(hides)
    await hides.setHidden(ME, "cleanup", cleanupId, true)

    const svc = service(repo)
    expect((await svc.listThreads(ME)).items).toHaveLength(0)

    repo.addMessage(cleanupId, {
      senderId: OTHER,
      body: "one more thing",
      createdAt: new Date("2026-06-01T11:30:00.000Z"),
    })

    const items = (await svc.listThreads(ME)).items
    expect(items.map((t) => t.id)).toEqual([cleanupId])
    expect(items[0]!.last).toBe("one more thing")
  })

  it("keeps a room hidden when activity lands exactly ON the hide instant", async () => {
    const hides = makeMemoryConversationHidesRepository(() => HIDDEN_AT)
    const { repo, cleanupId } = seededRepo(hides)
    await hides.setHidden(ME, "cleanup", cleanupId, true)
    repo.addMessage(cleanupId, { senderId: OTHER, body: "same instant", createdAt: HIDDEN_AT })

    expect((await service(repo).listThreads(ME)).items).toHaveLength(0)
  })

  it("brings the conversation back when the hide is cleared", async () => {
    const hides = makeMemoryConversationHidesRepository(() => HIDDEN_AT)
    const { repo, cleanupId } = seededRepo(hides)
    await hides.setHidden(ME, "cleanup", cleanupId, true)

    const svc = service(repo)
    expect((await svc.listThreads(ME)).items).toHaveLength(0)

    await hides.setHidden(ME, "cleanup", cleanupId, false)
    expect((await svc.listThreads(ME)).items.map((t) => t.id)).toEqual([cleanupId])
  })

  it("lists everything when no hides source is wired at all", async () => {
    const { repo, cleanupId } = seededRepo()
    expect((await service(repo).listThreads(ME)).items.map((t) => t.id)).toEqual([cleanupId])
  })

  it("fills a full page even when the newest `limit` rooms are all hidden", async () => {
    const hides = makeMemoryConversationHidesRepository(() => HIDDEN_AT)
    const repo = new InMemoryThreadsRepository(hides)
    const limit = 3
    const hiddenIds: string[] = []
    const visibleIds: string[] = []

    for (let i = 0; i < limit; i++) {
      const id = repo.seedCleanup(`hidden ${i}`)
      repo.addMember(id, ME, new Date("2026-06-01T08:00:00.000Z"))
      repo.addMessage(id, {
        senderId: OTHER,
        body: "old chatter",
        createdAt: new Date(Date.UTC(2026, 5, 1, 10, 50 + i)),
      })
      hiddenIds.push(id)
    }
    for (let i = 0; i < 5; i++) {
      const id = repo.seedCleanup(`visible ${i}`)
      repo.addMember(id, ME, new Date("2026-06-01T08:00:00.000Z"))
      repo.addMessage(id, {
        senderId: OTHER,
        body: "still here",
        createdAt: new Date(Date.UTC(2026, 5, 1, 9, 40 + i)),
      })
      visibleIds.push(id)
    }
    for (const id of hiddenIds) await hides.setHidden(ME, "cleanup", id, true)

    const page = await service(repo).list(ME, { limit })
    expect(page.items).toHaveLength(limit)
    expect(page.items.every((t) => visibleIds.includes(t.id))).toBe(true)
    expect(page.nextCursor).not.toBeNull()

    const next = await service(repo).list(ME, { limit, cursor: page.nextCursor })
    expect(next.items).toHaveLength(2)
    const seen = [...page.items, ...next.items].map((t) => t.id)
    expect(new Set(seen).size).toBe(5)
  })
})

describe("dm threads honor the viewer's hides too", () => {
  it("drops a hidden dm for the hider and resurfaces it on the next message", async () => {
    let hiddenNow = new Date(0)
    const hides = makeMemoryConversationHidesRepository(() => hiddenNow)
    const dmRepo = new InMemoryDmRepository(undefined, hides)
    dmRepo.registerUser({ id: ME, displayName: "Me", handle: "me" })
    dmRepo.registerUser({ id: OTHER, displayName: "Other", handle: "other" })
    const thread = await dmRepo.openOrCreateThread(ME, OTHER)
    await dmRepo.persist({ threadId: thread.id, senderId: OTHER, body: "hi" })

    const before = await dmRepo.listThreadsForUser(ME, 30)
    expect(before.map((t) => t.threadId)).toEqual([thread.id])
    hiddenNow = before[0]!.last!.createdAt
    await hides.setHidden(ME, "dm", thread.id, true)

    expect(await dmRepo.listThreadsForUser(ME, 30)).toHaveLength(0)
    expect((await dmRepo.listThreadsForUser(OTHER, 30)).map((t) => t.threadId)).toEqual([thread.id])

    await dmRepo.persist({ threadId: thread.id, senderId: OTHER, body: "still there?" })
    expect((await dmRepo.listThreadsForUser(ME, 30)).map((t) => t.threadId)).toEqual([thread.id])
  })
})
