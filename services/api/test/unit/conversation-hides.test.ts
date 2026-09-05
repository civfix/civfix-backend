import { describe, it, expect } from "vitest"
import {
  makeThreadsService,
  InMemoryChatReadState,
  isHiddenFor,
} from "../../src/services/threads-service.js"
import { makeMemoryConversationHidesRepository } from "../../src/services/conversation-hides-repository.memory.js"
import { InMemoryThreadsRepository } from "../helpers/chat.js"

const ME = "11111111-1111-1111-1111-111111111111"
const OTHER = "22222222-2222-2222-2222-222222222222"
const NOW = new Date("2026-06-01T12:00:00.000Z")

function seededRepo(): { repo: InMemoryThreadsRepository; cleanupId: string } {
  const repo = new InMemoryThreadsRepository()
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

describe("isHiddenFor", () => {
  it("hides a room whose latest activity is at or before the hide instant", () => {
    const hiddenAt = new Date("2026-06-01T11:00:00.000Z")
    expect(isHiddenFor(hiddenAt, hiddenAt.getTime())).toBe(true)
    expect(isHiddenFor(hiddenAt, hiddenAt.getTime() - 1)).toBe(true)
  })

  it("resurfaces a room the moment activity lands after the hide", () => {
    const hiddenAt = new Date("2026-06-01T11:00:00.000Z")
    expect(isHiddenFor(hiddenAt, hiddenAt.getTime() + 1)).toBe(false)
  })

  it("never hides a room the viewer has not hidden", () => {
    expect(isHiddenFor(undefined, 0)).toBe(false)
  })
})

describe("threads list with per-user hides", () => {
  it("drops a hidden conversation from the hider's list only", async () => {
    const { repo, cleanupId } = seededRepo()
    const hides = makeMemoryConversationHidesRepository(() => new Date("2026-06-01T11:00:00.000Z"))
    await hides.setHidden(ME, "cleanup", cleanupId, true)

    const svc = makeThreadsService({
      repo,
      readState: new InMemoryChatReadState(),
      hides,
      now: () => NOW,
    })

    expect((await svc.listThreads(ME)).items).toHaveLength(0)
    expect((await svc.listThreads(OTHER)).items.map((t) => t.id)).toEqual([cleanupId])
  })

  it("resurfaces the conversation when a message arrives after the hide", async () => {
    const { repo, cleanupId } = seededRepo()
    const hides = makeMemoryConversationHidesRepository(() => new Date("2026-06-01T11:00:00.000Z"))
    await hides.setHidden(ME, "cleanup", cleanupId, true)

    const svc = makeThreadsService({
      repo,
      readState: new InMemoryChatReadState(),
      hides,
      now: () => NOW,
    })
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

  it("brings the conversation back when the hide is cleared", async () => {
    const { repo, cleanupId } = seededRepo()
    const hides = makeMemoryConversationHidesRepository(() => new Date("2026-06-01T11:00:00.000Z"))
    await hides.setHidden(ME, "cleanup", cleanupId, true)

    const svc = makeThreadsService({
      repo,
      readState: new InMemoryChatReadState(),
      hides,
      now: () => NOW,
    })
    expect((await svc.listThreads(ME)).items).toHaveLength(0)

    await hides.setHidden(ME, "cleanup", cleanupId, false)
    expect((await svc.listThreads(ME)).items.map((t) => t.id)).toEqual([cleanupId])
  })

  it("lists everything when no hides source is wired at all", async () => {
    const { repo, cleanupId } = seededRepo()
    const svc = makeThreadsService({
      repo,
      readState: new InMemoryChatReadState(),
      now: () => NOW,
    })
    expect((await svc.listThreads(ME)).items.map((t) => t.id)).toEqual([cleanupId])
  })
})
