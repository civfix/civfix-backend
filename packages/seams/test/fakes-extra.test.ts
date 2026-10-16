import { describe, it, expect } from "vitest"
import { makeIdFactory } from "../src/fakes/ids.js"
import { FakeChatService } from "../src/fakes/chat-service.fake.js"
import { FakeAbuseChecks } from "../src/fakes/abuse-checks.fake.js"

/**
 * Edge coverage for the fakes' pure math: the deterministic id factory, the chat history cursor paging,
 * and the abuse FNV hash. fakes.test.ts covers interface conformance and the happy paths.
 */

const enc = new TextEncoder()

describe("makeIdFactory", () => {
  it("is deterministic for a given seed and produces v4-shaped UUIDs", () => {
    const a = makeIdFactory(123)
    const b = makeIdFactory(123)
    const idsA = [a(), a(), a()]
    const idsB = [b(), b(), b()]
    expect(idsA).toEqual(idsB)
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    for (const id of idsA) expect(id).toMatch(v4)
  })

  it("different seeds diverge", () => {
    const a = makeIdFactory(1)
    const b = makeIdFactory(2)
    expect(a()).not.toBe(b())
  })

  // 0 is a fixed point of xorshift32, so an unguarded seed 0 would emit ONE id forever and every fake
  // row would silently collide.
  it("still generates distinct ids for a seed that truncates to 0", () => {
    for (const seed of [0, 2 ** 32]) {
      const next = makeIdFactory(seed)
      const ids = [next(), next(), next()]
      expect(new Set(ids).size).toBe(3)
    }
  })
})

describe("FakeChatService history paging", () => {
  it("pages newest-first with a stable cursor across multiple pages", async () => {
    const chat = new FakeChatService()
    for (let i = 0; i < 5; i++) {
      await chat.persist({ cleanupId: "room", userId: "u1", body: `m${i}` })
    }

    const page1 = await chat.history("room", undefined, 2)
    expect(page1.items.map((m) => m.body)).toEqual(["m4", "m3"]) // newest first
    expect(page1.nextCursor).not.toBeNull()

    const page2 = await chat.history("room", page1.nextCursor ?? undefined, 2)
    expect(page2.items.map((m) => m.body)).toEqual(["m2", "m1"])
    expect(page2.nextCursor).not.toBeNull()

    const page3 = await chat.history("room", page2.nextCursor ?? undefined, 2)
    expect(page3.items.map((m) => m.body)).toEqual(["m0"])
    expect(page3.nextCursor).toBeNull() // exhausted
  })

  it("returns an empty page with a null cursor for an unknown room", async () => {
    const chat = new FakeChatService()
    const page = await chat.history("nope", undefined, 10)
    expect(page.items).toHaveLength(0)
    expect(page.nextCursor).toBeNull()
  })
})

describe("FakeChatService around-mode window (jump-to-message)", () => {
  /** Seed 9 messages m0(oldest)..m8(newest) and return their ids by index. */
  async function seed(chat: FakeChatService): Promise<string[]> {
    const ids: string[] = []
    for (let i = 0; i < 9; i++) {
      ids.push((await chat.persist({ cleanupId: "room", userId: "u1", body: `m${i}` })).id)
    }
    return ids
  }

  it("centers the window on the target (limit 5 = target + 2 older + 2 newer, newest-first) with cursors on both ends", async () => {
    const chat = new FakeChatService()
    const ids = await seed(chat)
    const page = await chat.history("room", undefined, 5, null, ids[4])
    // Newest-first: 2 newer, the target, 2 older. olderLimit=ceil(5/2)=3 INCLUDES the target itself.
    expect(page.items.map((m) => m.body)).toEqual(["m6", "m5", "m4", "m3", "m2"])
    // nextCursor = the OLDER end (older history exists: m0/m1); prevCursor = the NEWER end (m7/m8 exist).
    expect(page.nextCursor).toBe(ids[2]!)
    expect(page.prevCursor).toBe(ids[6]!)
  })

  it("nulls the cursors at the tail and head", async () => {
    const chat = new FakeChatService()
    const ids = await seed(chat)
    const atTail = await chat.history("room", undefined, 5, null, ids[0]) // oldest message
    expect(atTail.nextCursor).toBeNull() // window reaches the tail - nothing older
    expect(atTail.prevCursor).not.toBeNull()
    const atHead = await chat.history("room", undefined, 5, null, ids[8]) // newest message
    expect(atHead.prevCursor).toBeNull() // window touches the live head - nothing newer
    expect(atHead.nextCursor).not.toBeNull()
  })

  it("rejects an unknown target with a duck-typed 404 (statusCode, NOT an AppError instance)", async () => {
    const chat = new FakeChatService()
    await seed(chat)
    // The fakes entry is bundled apart from the package index, so an AppError thrown here would be a
    // DIFFERENT class object than consumers import - the contract is a fastify-style statusCode.
    await expect(chat.history("room", undefined, 5, null, "no-such-id")).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})

describe("FakeAbuseChecks pHash (FNV-1a)", () => {
  it("is deterministic and length-stable, and differs for different bytes", async () => {
    const a = new FakeAbuseChecks()
    const h1 = await a.pHash(enc.encode("alpha"))
    const h2 = await a.pHash(enc.encode("alpha"))
    const h3 = await a.pHash(enc.encode("beta"))
    expect(h1).toBe(h2)
    expect(h1).not.toBe(h3)
    expect(h1).toMatch(/^phash_[0-9a-f]{8}$/)
  })
})
