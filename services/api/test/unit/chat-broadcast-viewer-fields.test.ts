import { describe, it, expect, beforeEach } from "vitest"
import { handleClientFrame, type GatewayDeps, type GatewaySession } from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatPresence } from "../../src/adapters/chat-presence.js"
import { InMemoryChatRepository, MockConnection } from "../helpers/chat.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import { deleteMessageWithPowers } from "../../src/routes/chat-route-helpers.js"
import {
  makeChatEditService,
  type ChatEditServiceDeps,
} from "../../src/services/chat-edit-service.js"
import {
  makeChatPollService,
  type ChatPollServiceDeps,
  type PollRoomKind,
} from "../../src/services/chat-poll-service.js"
import type { ChatService } from "@civfix/shared/interfaces"
import { WsServerMessageSchema, type ChatMessageDTO, type WsServerMessage } from "@civfix/shared"

const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"
const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const MESSAGE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

let chat: WsChatService
let pubsub: InMemoryChatPubSub
let presence: InMemoryChatPresence
let repo: InMemoryChatRepository
let dmRepo: InMemoryDmRepository
let blocks: InMemoryBlocksRepository

function gatewayDeps(): GatewayDeps {
  return {
    chat,
    presence,
    isMember: (_roomId: string, userId: string) =>
      Promise.resolve(userId === ALICE || userId === BOB),
    reportVisible: () => Promise.resolve(true),
    reportChat: {
      isMember: () => Promise.resolve(true),
    } as unknown as GatewayDeps["reportChat"],
    groupChat: {
      access: () => Promise.resolve({ isMember: true, canPost: true, visibility: "private" }),
    } as unknown as GatewayDeps["groupChat"],
    dm: {
      peerOf: (threadId: string, userId: string) =>
        Promise.resolve(dmRepo.peerOf(threadId, userId)),
      persist: (input: Parameters<InMemoryDmRepository["persist"]>[0]) => dmRepo.persist(input),
      markRead: () => Promise.resolve(),
    },
    isBlockedEitherWay: (a: string, b: string) => blocks.isBlockedEitherWay(a, b),
  }
}

function sessionFor(userId: string, conn: MockConnection): GatewaySession {
  return {
    userId,
    conn,
    joined: new Set<string>(),
    typingThrottle: new Map<string, number>(),
    deps: gatewayDeps(),
  }
}

function frameOf(conn: MockConnection, type: string): Record<string, unknown> {
  const frames = conn.framesOfType(type)
  expect(frames).toHaveLength(1)
  for (const raw of conn.sent) {
    expect(WsServerMessageSchema.safeParse(JSON.parse(raw)).success, raw).toBe(true)
  }
  return frames[0]!
}

beforeEach(() => {
  pubsub = new InMemoryChatPubSub()
  presence = new InMemoryChatPresence()
  repo = new InMemoryChatRepository()
  repo.registerSender({ id: ALICE, displayName: "Alice" })
  repo.registerSender({ id: BOB, displayName: "Bob" })
  blocks = new InMemoryBlocksRepository()
  dmRepo = new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
  dmRepo.registerUser({ id: ALICE, displayName: "Alice", handle: "alice" })
  dmRepo.registerUser({ id: BOB, displayName: "Bob", handle: "bob" })
  chat = new WsChatService({ repo, pubsub })
})

async function sendInRoom(
  roomKind: "cleanup" | "report" | "group" | "dm",
  roomId: string,
): Promise<{ broadcast: ChatMessageDTO; ack: ChatMessageDTO }> {
  const aConn = new MockConnection("A")
  const bConn = new MockConnection("B")
  const aSession = sessionFor(ALICE, aConn)
  const bSession = sessionFor(BOB, bConn)
  const join = JSON.stringify({
    type: "join",
    cleanupId: roomId,
    ...(roomKind === "cleanup" ? {} : { roomKind }),
  })
  await handleClientFrame(aSession, join)
  await handleClientFrame(bSession, join)
  await handleClientFrame(
    aSession,
    JSON.stringify({
      type: "send",
      cleanupId: roomId,
      ...(roomKind === "cleanup" ? {} : { roomKind }),
      clientId: "client-1",
      body: "hello",
    }),
  )
  const broadcast = frameOf(bConn, "message") as unknown as { message: ChatMessageDTO }
  const ack = frameOf(aConn, "ack") as unknown as { message: ChatMessageDTO }
  return { broadcast: broadcast.message, ack: ack.message }
}

describe("F043 chat send fan-out never carries the sender's viewer fields", () => {
  it("a cleanup-room send reaches the peer socket with mine:false while the sender's ack keeps mine:true", async () => {
    const { broadcast, ack } = await sendInRoom("cleanup", ROOM)
    expect(broadcast.mine).toBe(false)
    expect(ack.mine).toBe(true)
    expect(ack.id).toBe(broadcast.id)
  })

  it("a report-room send reaches the peer socket with mine:false", async () => {
    const { broadcast, ack } = await sendInRoom("report", ROOM)
    expect(broadcast.mine).toBe(false)
    expect(ack.mine).toBe(true)
  })

  it("a group-room send reaches the peer socket with mine:false", async () => {
    const { broadcast, ack } = await sendInRoom("group", ROOM)
    expect(broadcast.mine).toBe(false)
    expect(ack.mine).toBe(true)
  })

  it("a DM send reaches the peer socket with mine:false", async () => {
    const thread = await dmRepo.openOrCreateThread(ALICE, BOB)
    const { broadcast, ack } = await sendInRoom("dm", thread.id)
    expect(broadcast.mine).toBe(false)
    expect(ack.mine).toBe(true)
  })
})

interface CapturedBroadcast {
  roomKey: string
  message: ChatMessageDTO
}

function captureChat(): {
  chat: ChatService
  broadcasts: CapturedBroadcast[]
  events: Array<{ roomKey: string; frame: WsServerMessage }>
} {
  const broadcasts: CapturedBroadcast[] = []
  const events: Array<{ roomKey: string; frame: WsServerMessage }> = []
  const stub = {
    broadcast: (roomKey: string, message: ChatMessageDTO) => {
      broadcasts.push({ roomKey, message })
      return Promise.resolve()
    },
    broadcastEvent: (roomKey: string, frame: WsServerMessage) => {
      events.push({ roomKey, frame })
      return Promise.resolve()
    },
  }
  return { chat: stub as unknown as ChatService, broadcasts, events }
}

function tombstoneDto(): ChatMessageDTO {
  return {
    id: MESSAGE,
    cleanupId: ROOM,
    kind: "text",
    createdAt: "2026-06-01T12:00:00.000Z",
    deletedAt: "2026-06-01T12:30:00.000Z",
    reactions: [{ emoji: "heart", count: 1, mine: true }],
    mentions: [],
    mine: true,
  }
}

describe("F043 delete tombstones fan out without the deleter's viewer fields", () => {
  it.each(["cleanup", "report", "group"] as const)(
    "a %s-room tombstone is broadcast with mine:false while the caller keeps its own view",
    async (roomKind) => {
      const { chat: stub, broadcasts, events } = captureChat()
      const returned = await deleteMessageWithPowers({
        roomKind,
        roomId: ROOM,
        messageId: MESSAGE,
        userId: ALICE,
        senderPath: true,
        softDelete: () => Promise.resolve(tombstoneDto()),
        findMessageMeta: () => Promise.resolve(null),
        resolveChatPowers: () =>
          Promise.resolve({ canDeleteOthers: true, canPin: true, isModerator: true }),
        chat: stub,
        legacyBroadcast: true,
      })

      expect(returned.mine).toBe(true)
      expect(broadcasts).toHaveLength(1)
      expect(broadcasts[0]!.message.mine).toBe(false)
      expect(broadcasts[0]!.message.reactions?.[0]?.mine).toBe(false)
      expect(events).toHaveLength(1)
      const frame = events[0]!.frame as { type: string; message: ChatMessageDTO }
      expect(frame.type).toBe("message_update")
      expect(frame.message.mine).toBe(false)
      expect(frame.message.reactions?.[0]?.mine).toBe(false)
    },
  )
})

describe("F043 edits fan out without the editor's viewer fields", () => {
  it("a cleanup-room edit broadcasts message_update with mine:false while the editor keeps mine:true", async () => {
    const events: Array<{ roomKey: string; frame: WsServerMessage }> = []
    const inserted = await repo.insertMessage(
      { cleanupId: ROOM, userId: ALICE, body: "before" },
      MESSAGE,
    )
    const edits = makeChatEditService({
      chat: repo as unknown as ChatEditServiceDeps["chat"],
      isCleanupMember: () => Promise.resolve(true),
      broadcastEvent: (roomKey, frame) => {
        events.push({ roomKey, frame })
      },
    })
    const updated = await edits.editMessage({
      roomKind: "cleanup",
      roomId: ROOM,
      messageId: inserted.id,
      userId: ALICE,
      body: "after",
    })

    expect(updated.mine).toBe(true)
    expect(events).toHaveLength(1)
    const frame = events[0]!.frame as { type: string; message: ChatMessageDTO }
    expect(frame.type).toBe("message_update")
    expect(frame.message.body).toBe("after")
    expect(frame.message.mine).toBe(false)
  })
})

function pollDto(): ChatMessageDTO {
  return {
    id: MESSAGE,
    cleanupId: ROOM,
    kind: "poll",
    createdAt: "2026-06-01T12:00:00.000Z",
    reactions: [],
    mentions: [],
    mine: true,
    poll: {
      question: "Where?",
      options: [{ idx: 0, text: "Park", count: 1, mine: true }],
      allowMultiple: false,
      anonymous: false,
      closed: false,
      myVote: [0],
      totalVoters: 1,
    },
  }
}

describe("F043 poll creation fans out the room view, not the author's", () => {
  it("the created poll broadcast has mine:false and an empty myVote while the author's response keeps both", async () => {
    const broadcasts: Array<{ roomKind: PollRoomKind; message: ChatMessageDTO }> = []
    const deps = {
      chat: {
        findMessage: () => Promise.resolve(pollDto()),
      },
      chatPolls: {
        create: () => Promise.resolve(),
      },
      canSend: () => Promise.resolve(true),
      isMember: () => Promise.resolve(true),
      isModerator: () => Promise.resolve(false),
      newId: () => MESSAGE,
      broadcastMessage: (roomKind: PollRoomKind, _roomId: string, message: ChatMessageDTO) => {
        broadcasts.push({ roomKind, message })
      },
      broadcastUpdate: () => {},
      notifyRoom: () => {},
    } as unknown as ChatPollServiceDeps

    const created = await makeChatPollService(deps).createPoll({
      roomKind: "cleanup",
      roomId: ROOM,
      question: "Where?",
      options: ["Park"],
      allowMultiple: false,
      anonymous: false,
      userId: ALICE,
    })

    expect(created.mine).toBe(true)
    expect(created.poll?.myVote).toEqual([0])
    expect(broadcasts).toHaveLength(1)
    const fanned = broadcasts[0]!.message
    expect(fanned.mine).toBe(false)
    expect(fanned.poll?.myVote).toEqual([])
    expect(fanned.poll?.options[0]?.mine).toBe(false)
  })
})
