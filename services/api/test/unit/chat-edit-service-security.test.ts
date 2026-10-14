import { describe, it, expect } from "vitest"
import { randomUUID } from "node:crypto"
import { makeChatEditService } from "../../src/services/chat-edit-service.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import { InMemoryChatRepository } from "../helpers/chat.js"

const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const BOB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const MALLORY = "dddddddd-dddd-dddd-dddd-dddddddddddd"
const ROOM = "cccccccc-cccc-cccc-cccc-cccccccccccc"

const onlyAlice = (_roomId: string, userId: string): Promise<boolean> =>
  Promise.resolve(userId === ALICE)

type RoomLane = "cleanup" | "group" | "report"

async function roomLane(kind: RoomLane) {
  const chat = new InMemoryChatRepository()
  chat.registerSender({ id: ALICE, displayName: "Alice", handle: "alice" })
  const msg = await chat.insertMessage(
    {
      cleanupId: ROOM,
      userId: ALICE,
      body: "hi",
      ...(kind === "cleanup" ? {} : { roomKind: kind }),
    },
    randomUUID(),
  )
  const service = makeChatEditService({
    chat,
    isCleanupMember: onlyAlice,
    isGroupMember: onlyAlice,
    isReportMember: onlyAlice,
    isReportVisible: () => Promise.resolve(true),
  })
  return { service, messageId: msg.id }
}

async function dmLane() {
  const blocks = new InMemoryBlocksRepository()
  const dm = new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
  dm.registerUser({ id: ALICE, displayName: "Alice", handle: "alice" })
  dm.registerUser({ id: BOB, displayName: "Bob", handle: "bob" })
  const thread = await dm.openOrCreateThread(ALICE, BOB)
  const msg = await dm.persist({ threadId: thread.id, senderId: ALICE, body: "hi bob" })
  const service = makeChatEditService({
    dm,
    dmPeerOf: (threadId, userId) => Promise.resolve(dm.peerOf(threadId, userId)),
    isBlockedEitherWay: (a, b) => blocks.isBlockedEitherWay(a, b),
  })
  return { service, threadId: thread.id, messageId: msg.id }
}

describe("chat edit answers an outsider the same way whatever message id they probe", () => {
  it.each(["cleanup", "group", "report"] as const)(
    "a %s non-member gets 403 for a message in the room AND for an unknown id",
    async (kind) => {
      const { service, messageId } = await roomLane(kind)
      const edit = (id: string) =>
        service.editMessage({
          roomKind: kind,
          roomId: ROOM,
          messageId: id,
          userId: MALLORY,
          body: "x",
        })
      await expect(edit(messageId)).rejects.toMatchObject({ httpStatus: 403 })
      await expect(edit(randomUUID())).rejects.toMatchObject({ httpStatus: 403 })
    },
  )

  it.each(["cleanup", "group", "report"] as const)(
    "a %s member still gets 404 for a message that is not in the room",
    async (kind) => {
      const { service } = await roomLane(kind)
      await expect(
        service.editMessage({
          roomKind: kind,
          roomId: ROOM,
          messageId: randomUUID(),
          userId: ALICE,
          body: "x",
        }),
      ).rejects.toMatchObject({ httpStatus: 404 })
    },
  )

  it("a report that is not visible answers 404 for any id, before membership", async () => {
    const chat = new InMemoryChatRepository()
    const service = makeChatEditService({
      chat,
      isReportMember: onlyAlice,
      isReportVisible: () => Promise.resolve(false),
    })
    await expect(
      service.editMessage({
        roomKind: "report",
        roomId: ROOM,
        messageId: randomUUID(),
        userId: MALLORY,
        body: "x",
      }),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("a dm outsider gets 403 for a message in the thread AND for an unknown id", async () => {
    const { service, threadId, messageId } = await dmLane()
    const edit = (id: string) =>
      service.editMessage({
        roomKind: "dm",
        roomId: threadId,
        messageId: id,
        userId: MALLORY,
        body: "x",
      })
    await expect(edit(messageId)).rejects.toMatchObject({ httpStatus: 403 })
    await expect(edit(randomUUID())).rejects.toMatchObject({ httpStatus: 403 })
  })

  it("a dm participant still gets 404 for a message that is not in the thread", async () => {
    const { service, threadId } = await dmLane()
    await expect(
      service.editMessage({
        roomKind: "dm",
        roomId: threadId,
        messageId: randomUUID(),
        userId: BOB,
        body: "x",
      }),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })
})
