/**
 * Offline unit tests for chat-edit-service branches the pg integration suite
 * (test/integration/messages-edit-pg.test.ts) can't cheaply reach:
 *
 *   - the LOST-RACE branch: the meta resolves live but the sender-gated UPDATE matches nothing
 *     (e.g. tombstoned between the gate ladder and the write) -> 409;
 *   - mention re-resolution REPLACES the recorded set — an edit that drops every @mention records
 *     an EMPTY replace (clearing the stale rows), and the resolver sees the parsed handles;
 *   - the DM room-send re-check: a blocked-either-way peer is a plain 403 (before any state gate);
 *   - the slur filter runs on the edited body -> 422.
 *
 * Uses the in-memory repos (the same fakes the dm route tests use) — no DB, no server boot.
 */

import { describe, it, expect } from "vitest"
import { randomUUID } from "node:crypto"
import type { UserMentionDTO } from "@civfix/shared"
import { makeChatEditService } from "../../src/services/chat-edit-service.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import { InMemoryChatRepository } from "../helpers/chat.js"

const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const BOB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const ROOM = "cccccccc-cccc-cccc-cccc-cccccccccccc"

function cleanupHarness() {
  const chat = new InMemoryChatRepository()
  chat.registerSender({ id: ALICE, displayName: "Alice", handle: "alice" })
  return chat
}

function dmHarness() {
  const blocks = new InMemoryBlocksRepository()
  const dm = new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
  dm.registerUser({ id: ALICE, displayName: "Alice", handle: "alice" })
  dm.registerUser({ id: BOB, displayName: "Bob", handle: "bob" })
  return { blocks, dm }
}

describe("chat-edit-service (offline branches)", () => {
  it("409s the LOST RACE: meta resolves live but the sender-gated UPDATE matches nothing", async () => {
    const chat = cleanupHarness()
    const msg = await chat.insertMessage(
      { cleanupId: ROOM, userId: ALICE, body: "hi" },
      randomUUID(),
    )
    // Simulate the row being tombstoned between findMessageMeta and the gated UPDATE: the meta still
    // reads live, but the edit write matches nothing.
    chat.editMessage = () => Promise.resolve(null)

    const service = makeChatEditService({
      chat,
      isCleanupMember: () => Promise.resolve(true),
    })
    await expect(
      service.editMessage({
        roomKind: "cleanup",
        roomId: ROOM,
        messageId: msg.id,
        userId: ALICE,
        body: "lost the race",
      }),
    ).rejects.toMatchObject({ httpStatus: 409 })
  })

  it("REPLACES the mention set: dropping every @mention records an EMPTY replace", async () => {
    const chat = cleanupHarness()
    const msg = await chat.insertMessage(
      { cleanupId: ROOM, userId: ALICE, body: "hey @bob" },
      randomUUID(),
    )

    const resolveInputs: { handles: string[]; userIds: string[] }[] = []
    const recorded: { messageId: string; ids: string[] }[] = []
    const service = makeChatEditService({
      chat,
      isCleanupMember: () => Promise.resolve(true),
      chatMentions: {
        resolveChatMentions: (input) => {
          resolveInputs.push({ handles: input.handles, userIds: input.userIds })
          // The edited body carries no @mention, so nothing resolves.
          return Promise.resolve<UserMentionDTO[]>([])
        },
        recordChatMentions: (messageId, ids) => {
          recorded.push({ messageId, ids })
          return Promise.resolve()
        },
      },
    })

    const updated = await service.editMessage({
      roomKind: "cleanup",
      roomId: ROOM,
      messageId: msg.id,
      userId: ALICE,
      body: "hey everyone",
    })
    expect(updated.body).toBe("hey everyone")
    // The resolver saw the edited body's (empty) parse, and the record call REPLACED with an empty set.
    expect(resolveInputs).toEqual([{ handles: [], userIds: [] }])
    expect(recorded).toEqual([{ messageId: msg.id, ids: [] }])
  })

  it("passes parsed @handles from the edited body to the mention resolver", async () => {
    const chat = cleanupHarness()
    const msg = await chat.insertMessage(
      { cleanupId: ROOM, userId: ALICE, body: "plain" },
      randomUUID(),
    )

    const resolveInputs: { handles: string[] }[] = []
    const service = makeChatEditService({
      chat,
      isCleanupMember: () => Promise.resolve(true),
      chatMentions: {
        resolveChatMentions: (input) => {
          resolveInputs.push({ handles: input.handles })
          return Promise.resolve<UserMentionDTO[]>([])
        },
        recordChatMentions: () => Promise.resolve(),
      },
    })

    await service.editMessage({
      roomKind: "cleanup",
      roomId: ROOM,
      messageId: msg.id,
      userId: ALICE,
      body: "now pinging @bob",
    })
    expect(resolveInputs).toEqual([{ handles: ["bob"] }])
  })

  it("403s a DM edit when the peer is blocked either way (plain 403, before state gates)", async () => {
    const { blocks, dm } = dmHarness()
    const thread = await dm.openOrCreateThread(ALICE, BOB)
    const msg = await dm.persist({ threadId: thread.id, senderId: ALICE, body: "hi bob" })
    await blocks.block(BOB, ALICE)

    const service = makeChatEditService({
      dm,
      dmPeerOf: (threadId, userId) => Promise.resolve(dm.peerOf(threadId, userId)),
      isBlockedEitherWay: (a, b) => blocks.isBlockedEitherWay(a, b),
    })
    await expect(
      service.editMessage({
        roomKind: "dm",
        roomId: thread.id,
        messageId: msg.id,
        userId: ALICE,
        body: "hello?",
      }),
    ).rejects.toMatchObject({ httpStatus: 403, fields: undefined })
  })

  it("422s an edited body that contains a hate slur (F1 gate runs on edit)", async () => {
    const { blocks, dm } = dmHarness()
    const thread = await dm.openOrCreateThread(ALICE, BOB)
    const msg = await dm.persist({ threadId: thread.id, senderId: ALICE, body: "ok" })

    const service = makeChatEditService({
      dm,
      dmPeerOf: (threadId, userId) => Promise.resolve(dm.peerOf(threadId, userId)),
      isBlockedEitherWay: (a, b) => blocks.isBlockedEitherWay(a, b),
    })
    await expect(
      service.editMessage({
        roomKind: "dm",
        roomId: thread.id,
        messageId: msg.id,
        userId: ALICE,
        body: "you retard",
      }),
    ).rejects.toMatchObject({ httpStatus: 422 })
  })
})
