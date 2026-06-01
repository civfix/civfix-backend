import { describe, it, expect } from "vitest"
import { relativeAgo } from "@civfix/shared"
import {
  makeThreadsService,
  InMemoryChatReadState,
} from "../../src/services/threads-service.js"
import { InMemoryThreadsRepository } from "../helpers/chat.js"

/**
 * Unit tests for the threads service over the in-memory ThreadsRepository (no DB). Proves the
 * MessageThreadDTO derivation: title, last preview, ago, members, unread (others' messages after the
 * read watermark), and lastFromMe (the last message's sender is the viewer).
 */

const ME = "11111111-1111-1111-1111-111111111111"
const OTHER = "22222222-2222-2222-2222-222222222222"

const NOW = new Date("2026-06-01T12:00:00.000Z")

describe("relativeAgo (shared)", () => {
  it("buckets durations into now / Nm / Nh / Nd (shared default text)", () => {
    // The shared relativeAgo renders the near bucket as "now" (the reconciled default; the backend's
    // former "just now" is available via opts.justNow, but we adopt the shared default for consistency).
    expect(relativeAgo(new Date("2026-06-01T11:59:30.000Z"), NOW)).toBe("now")
    expect(relativeAgo(new Date("2026-06-01T11:55:00.000Z"), NOW)).toBe("5m")
    expect(relativeAgo(new Date("2026-06-01T09:00:00.000Z"), NOW)).toBe("3h")
    expect(relativeAgo(new Date("2026-05-29T12:00:00.000Z"), NOW)).toBe("3d")
    // Week-plus now buckets to "Nw" (was previously "Nd" past 7 days in the old backend impl).
    expect(relativeAgo(new Date("2026-05-18T12:00:00.000Z"), NOW)).toBe("2w")
  })
})

describe("threads service", () => {
  it("derives unread (others' messages after join) and lastFromMe", async () => {
    const repo = new InMemoryThreadsRepository()
    const c1 = repo.seedCleanup("Beach sweep")
    repo.addMember(c1, ME, new Date("2026-06-01T10:00:00.000Z"))
    repo.addMember(c1, OTHER, new Date("2026-06-01T09:00:00.000Z"))

    // Two messages from OTHER after I joined -> unread 2; the last message is from OTHER -> lastFromMe false.
    repo.addMessage(c1, { senderId: OTHER, body: "hi all", createdAt: new Date("2026-06-01T11:00:00.000Z") })
    repo.addMessage(c1, { senderId: OTHER, body: "see you there", createdAt: new Date("2026-06-01T11:30:00.000Z") })

    const svc = makeThreadsService({ repo, readState: new InMemoryChatReadState(), now: () => NOW })
    const { items } = await svc.listThreads(ME)
    expect(items).toHaveLength(1)
    const t = items[0]!
    expect(t.id).toBe(c1)
    expect(t.kind).toBe("cleanup")
    expect(t.title).toBe("Beach sweep")
    expect(t.last).toBe("see you there")
    expect(t.ago).toBe("30m")
    expect(t.members).toBe(2)
    expect(t.unread).toBe(2)
    expect(t.lastFromMe).toBe(false)
  })

  it("does not count my own messages as unread, and sets lastFromMe when I sent last", async () => {
    const repo = new InMemoryThreadsRepository()
    const c1 = repo.seedCleanup("Park cleanup")
    repo.addMember(c1, ME, new Date("2026-06-01T10:00:00.000Z"))
    repo.addMessage(c1, { senderId: OTHER, body: "yo", createdAt: new Date("2026-06-01T10:30:00.000Z") })
    repo.addMessage(c1, { senderId: ME, body: "on my way", createdAt: new Date("2026-06-01T11:00:00.000Z") })

    const svc = makeThreadsService({ repo, readState: new InMemoryChatReadState(), now: () => NOW })
    const { items } = await svc.listThreads(ME)
    const t = items[0]!
    // Only OTHER's one message is unread; mine is excluded.
    expect(t.unread).toBe(1)
    expect(t.lastFromMe).toBe(true)
    expect(t.last).toBe("on my way")
  })

  it("a read watermark from ChatReadState clears earlier unread", async () => {
    const repo = new InMemoryThreadsRepository()
    const c1 = repo.seedCleanup("Trail day")
    repo.addMember(c1, ME, new Date("2026-06-01T08:00:00.000Z"))
    repo.addMessage(c1, { senderId: OTHER, body: "old", createdAt: new Date("2026-06-01T09:00:00.000Z") })
    repo.addMessage(c1, { senderId: OTHER, body: "new", createdAt: new Date("2026-06-01T11:00:00.000Z") })

    const readState = new InMemoryChatReadState()
    // I read up to 10:00 -> only the 11:00 message is unread.
    await readState.markRead(c1, ME, new Date("2026-06-01T10:00:00.000Z"))

    const svc = makeThreadsService({ repo, readState, now: () => NOW })
    const { items } = await svc.listThreads(ME)
    expect(items[0]!.unread).toBe(1)
  })

  it("an empty room has null last/ago and zero unread", async () => {
    const repo = new InMemoryThreadsRepository()
    const c1 = repo.seedCleanup("Fresh event")
    repo.addMember(c1, ME, new Date("2026-06-01T10:00:00.000Z"))

    const svc = makeThreadsService({ repo, readState: new InMemoryChatReadState(), now: () => NOW })
    const t = (await svc.listThreads(ME)).items[0]!
    expect(t.last).toBeNull()
    expect(t.ago).toBeNull()
    expect(t.unread).toBe(0)
    expect(t.lastFromMe).toBe(false)
  })

  it("only returns cleanups the viewer is a member of", async () => {
    const repo = new InMemoryThreadsRepository()
    const mine = repo.seedCleanup("Mine")
    const theirs = repo.seedCleanup("Theirs")
    repo.addMember(mine, ME, new Date("2026-06-01T10:00:00.000Z"))
    repo.addMember(theirs, OTHER, new Date("2026-06-01T10:00:00.000Z"))

    const svc = makeThreadsService({ repo, readState: new InMemoryChatReadState(), now: () => NOW })
    const { items } = await svc.listThreads(ME)
    expect(items.map((t) => t.title)).toEqual(["Mine"])
  })

  it("orders threads by most recent activity first", async () => {
    const repo = new InMemoryThreadsRepository()
    const a = repo.seedCleanup("A-older-activity")
    const b = repo.seedCleanup("B-newer-activity")
    repo.addMember(a, ME, new Date("2026-06-01T08:00:00.000Z"))
    repo.addMember(b, ME, new Date("2026-06-01T08:00:00.000Z"))
    repo.addMessage(a, { senderId: OTHER, body: "old", createdAt: new Date("2026-06-01T09:00:00.000Z") })
    repo.addMessage(b, { senderId: OTHER, body: "new", createdAt: new Date("2026-06-01T11:00:00.000Z") })

    const svc = makeThreadsService({ repo, readState: new InMemoryChatReadState(), now: () => NOW })
    const { items } = await svc.listThreads(ME)
    expect(items.map((t) => t.title)).toEqual(["B-newer-activity", "A-older-activity"])
  })
})
