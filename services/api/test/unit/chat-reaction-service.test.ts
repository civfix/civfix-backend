/**
 * The chat reaction service over the in-memory chat/dm/blocks repos. The Drizzle repos and the
 * chat_message_reactions table are covered by the integration suite; these fakes exercise the same seam.
 */

import { describe, expect, it } from "vitest"
import { AppError } from "@civfix/shared"
import {
  makeChatReactionService,
  type ChatReactionService,
} from "../../src/services/chat-reaction-service.js"
import { InMemoryChatRepository } from "../helpers/chat.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"

const CLEANUP = "11111111-1111-1111-1111-111111111111"
const ALICE = "22222222-2222-2222-2222-222222222222"
const BOB = "33333333-3333-3333-3333-333333333333"
const CAROL = "44444444-4444-4444-4444-444444444444"
const MSG_ID = "55555555-5555-5555-5555-555555555555"

interface Harness {
  chat: InMemoryChatRepository
  dm: InMemoryDmRepository
  blocks: InMemoryBlocksRepository
  members: Set<string>
  service: ChatReactionService
}

function makeHarness(): Harness {
  const chat = new InMemoryChatRepository()
  const blocks = new InMemoryBlocksRepository()
  const dm = new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
  dm.registerUser({ id: ALICE, displayName: "Alice", handle: "alice" })
  dm.registerUser({ id: BOB, displayName: "Bob", handle: "bob" })
  const members = new Set<string>([ALICE, BOB])
  const service = makeChatReactionService({
    chat,
    dm,
    isCleanupMember: (cleanupId, userId) =>
      Promise.resolve(cleanupId === CLEANUP && members.has(userId)),
    dmPeerOf: async (threadId, userId) => {
      const t = await dm.getThread(threadId)
      if (t === null) return null
      if (t.userLo === userId) return t.userHi
      if (t.userHi === userId) return t.userLo
      return null
    },
    isBlockedEitherWay: (a, b) => blocks.isBlockedEitherWay(a, b),
  })
  return { chat, dm, blocks, members, service }
}

describe("chat reaction service: cleanup group chat", () => {
  it("toggles a reaction on, then off, recomputing the count + the viewer's mine", async () => {
    const h = makeHarness()
    await h.chat.insertMessage({ cleanupId: CLEANUP, userId: ALICE, body: "hi" }, MSG_ID)

    const on = await h.service.toggleCleanupReaction(CLEANUP, MSG_ID, BOB, "like")
    expect(on.reactions).toEqual([{ emoji: "like", count: 1, mine: true }])

    const off = await h.service.toggleCleanupReaction(CLEANUP, MSG_ID, BOB, "like")
    expect(off.reactions).toEqual([])
  })

  it("resolves mine per-viewer (Bob's like is not mine for Alice)", async () => {
    const h = makeHarness()
    await h.chat.insertMessage({ cleanupId: CLEANUP, userId: ALICE, body: "hi" }, MSG_ID)
    await h.service.toggleCleanupReaction(CLEANUP, MSG_ID, BOB, "heart")

    const forAlice = await h.chat.findMessage(CLEANUP, MSG_ID, ALICE)
    expect(forAlice?.reactions).toEqual([{ emoji: "heart", count: 1, mine: false }])
  })

  it("403s a non-member", async () => {
    const h = makeHarness()
    await h.chat.insertMessage({ cleanupId: CLEANUP, userId: ALICE, body: "hi" }, MSG_ID)
    await expect(
      h.service.toggleCleanupReaction(CLEANUP, MSG_ID, CAROL, "like"),
    ).rejects.toMatchObject({ httpStatus: 403 })
  })

  it("404s a missing message", async () => {
    const h = makeHarness()
    await expect(
      h.service.toggleCleanupReaction(CLEANUP, MSG_ID, ALICE, "like"),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("422s an unsupported emoji", async () => {
    const h = makeHarness()
    await h.chat.insertMessage({ cleanupId: CLEANUP, userId: ALICE, body: "hi" }, MSG_ID)
    await expect(
      h.service.toggleCleanupReaction(CLEANUP, MSG_ID, ALICE, "thumbsup" as any),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe("chat reaction service: direct messages", () => {
  it("toggles a reaction on a dm message and recomputes for the viewer", async () => {
    const h = makeHarness()
    const thread = await h.dm.openOrCreateThread(ALICE, BOB)
    const msg = await h.dm.persist({ threadId: thread.id, senderId: ALICE, body: "yo" })

    const on = await h.service.toggleDmReaction(thread.id, msg.id, BOB, "celebrate")
    expect(on.reactions).toEqual([{ emoji: "celebrate", count: 1, mine: true }])

    const off = await h.service.toggleDmReaction(thread.id, msg.id, BOB, "celebrate")
    expect(off.reactions).toEqual([])
  })

  it("403s a non-participant", async () => {
    const h = makeHarness()
    const thread = await h.dm.openOrCreateThread(ALICE, BOB)
    const msg = await h.dm.persist({ threadId: thread.id, senderId: ALICE, body: "yo" })
    await expect(
      h.service.toggleDmReaction(thread.id, msg.id, CAROL, "like"),
    ).rejects.toMatchObject({ httpStatus: 403 })
  })

  it("403s when the pair is blocked either way", async () => {
    const h = makeHarness()
    const thread = await h.dm.openOrCreateThread(ALICE, BOB)
    const msg = await h.dm.persist({ threadId: thread.id, senderId: ALICE, body: "yo" })
    await h.blocks.block(ALICE, BOB)
    await expect(h.service.toggleDmReaction(thread.id, msg.id, BOB, "like")).rejects.toMatchObject({
      httpStatus: 403,
    })
  })

  it("404s a missing dm message", async () => {
    const h = makeHarness()
    const thread = await h.dm.openOrCreateThread(ALICE, BOB)
    await expect(
      h.service.toggleDmReaction(thread.id, MSG_ID, ALICE, "like"),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })
})
