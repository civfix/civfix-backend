import { describe, it, expect, beforeEach } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import {
  handleClientFrame,
  type GatewayDeps,
  type GatewayDmDeps,
  type GatewaySession,
  type OnDmDelivered,
} from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatPresence } from "../../src/adapters/chat-presence.js"
import { MockConnection } from "../helpers/chat.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import { InMemoryNotificationRepository } from "../helpers/notifications.js"
import {
  makeNotificationService,
  type NotificationService,
} from "../../src/services/notification-service.js"


const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"
const CLEANUP = "55555555-5555-5555-5555-555555555555"

let chat: WsChatService
let pubsub: InMemoryChatPubSub
let presence: InMemoryChatPresence
let dmRepo: InMemoryDmRepository
let blocks: InMemoryBlocksRepository
let notifRepo: InMemoryNotificationRepository
let push: FakePushSender
let notifications: NotificationService
let THREAD: string

const onDmDelivered: OnDmDelivered = async (threadId, recipientId, message) => {
  await notifications.createNotification(recipientId, {
    type: "dm",
    title: message.from.name.trim() !== "" ? message.from.name : message.from.handle ? `@${message.from.handle}` : "",
    body: typeof message.body === "string" ? message.body : "Sent you a message",
    link: `/messages/dm/${threadId}`,
  })
}

function dmDeps(): GatewayDmDeps {
  return {
    isParticipant: (threadId, userId) => dmRepo.isParticipant(threadId, userId),
    peerOf: (threadId, userId) => Promise.resolve(dmRepo.peerOf(threadId, userId)),
    persist: (input) => dmRepo.persist(input),
    markRead: async (threadId, userId) => {
      await dmRepo.markRead(threadId, userId, new Date())
      await notifications.clearByTypeAndLink(userId, "dm", `/messages/dm/${threadId}`)
    },
  }
}

function depsFor(): GatewayDeps {
  return {
    chat,
    isMember: (cleanupId, userId) =>
      Promise.resolve(cleanupId === CLEANUP && (userId === ALICE || userId === BOB)),
    presence,
    dm: dmDeps(),
    isBlockedEitherWay: (a, b) => blocks.isBlockedEitherWay(a, b),
    onDmDelivered,
    markRead: async (cleanupId, userId) => {
      await notifications.clearByTypeAndLink(userId, "cleanup_chat", `/cleanups/${cleanupId}`)
    },
  }
}

function sessionFor(userId: string, conn: MockConnection): GatewaySession {
  return {
    userId,
    conn,
    joined: new Set<string>(),
    typingThrottle: new Map<string, number>(),
    deps: depsFor(),
  }
}

function makeUnusedChatRepo() {
  return {
    insertMessage: () => Promise.reject(new Error("cleanup persist not expected here")),
    history: () => Promise.resolve({ items: [], nextCursor: null }),
    findMessage: () => Promise.resolve(null),
    toggleReaction: () => Promise.reject(new Error("cleanup reaction not expected here")),
    softDelete: () => Promise.reject(new Error("cleanup delete not expected here")),
    reportHistory: () => Promise.resolve({ items: [], nextCursor: null }),
    findReportMessage: () => Promise.resolve(null),
    softDeleteReport: () => Promise.reject(new Error("report delete not expected here")),
    countReportMessages: () => Promise.resolve(0),
  }
}

function unreadDmNotifs(userId: string): typeof notifRepo.notifications {
  return notifRepo.notifications.filter(
    (n) => n.userId === userId && n.type === "dm" && n.readAt === null,
  )
}

beforeEach(async () => {
  pubsub = new InMemoryChatPubSub()
  presence = new InMemoryChatPresence()
  blocks = new InMemoryBlocksRepository()
  dmRepo = new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
  dmRepo.registerUser({ id: ALICE, displayName: "Alice", handle: "alice" })
  dmRepo.registerUser({ id: BOB, displayName: "Bob", handle: "bob" })
  chat = new WsChatService({ repo: makeUnusedChatRepo(), pubsub })
  notifRepo = new InMemoryNotificationRepository()
  push = new FakePushSender()
  notifications = makeNotificationService({ repo: notifRepo, pushSender: push })
  const thread = await dmRepo.openOrCreateThread(ALICE, BOB)
  THREAD = thread.id
})

describe("DM bell notifications (#42)", () => {
  it("a dm send creates a `dm` notification for the PEER (not the sender) and pushes", async () => {
    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))
    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: THREAD, roomKind: "dm", clientId: "c1", body: "hi bob" }),
    )
    await new Promise((r) => setTimeout(r, 0))

    const bobNotifs = unreadDmNotifs(BOB)
    expect(bobNotifs).toHaveLength(1)
    expect(bobNotifs[0]!.link).toBe(`/messages/dm/${THREAD}`)
    expect(bobNotifs[0]!.title).toBe("Alice")
    expect(bobNotifs[0]!.body).toBe("hi bob")
    expect(unreadDmNotifs(ALICE)).toHaveLength(0)

    expect(push.sent.some((p) => p.userId === BOB)).toBe(true)
    expect(push.sent.some((p) => p.userId === ALICE)).toBe(false)
  })

  it("SUPPRESSES the notification when the recipient is actively viewing the dm room", async () => {
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const aSession = sessionFor(ALICE, aConn)
    const bSession = sessionFor(BOB, bConn)
    await handleClientFrame(bSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))

    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: THREAD, roomKind: "dm", clientId: "c1", body: "you there?" }),
    )
    await new Promise((r) => setTimeout(r, 0))

    expect(unreadDmNotifs(BOB)).toHaveLength(0)
    expect(push.sent.some((p) => p.userId === BOB)).toBe(false)
  })

  it("reading the dm conversation clears the recipient's `dm` notification", async () => {
    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))
    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: THREAD, roomKind: "dm", clientId: "c1", body: "ping" }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(unreadDmNotifs(BOB)).toHaveLength(1)

    const bConn = new MockConnection("B")
    const bSession = sessionFor(BOB, bConn)
    await handleClientFrame(bSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))
    await handleClientFrame(
      bSession,
      JSON.stringify({
        type: "ack",
        upToId: "44444444-4444-4444-4444-444444444444",
        cleanupId: THREAD,
        roomKind: "dm",
      }),
    )
    expect(unreadDmNotifs(BOB)).toHaveLength(0)
  })

  it("reading a cleanup conversation clears its `cleanup_chat` notification", async () => {
    await notifications.createNotification(BOB, {
      type: "cleanup_chat",
      title: "Cleanup update",
      body: "The cleanup time changed.",
      link: `/cleanups/${CLEANUP}`,
    })
    const before = notifRepo.notifications.filter(
      (n) => n.userId === BOB && n.type === "cleanup_chat" && n.readAt === null,
    )
    expect(before).toHaveLength(1)

    const bConn = new MockConnection("B")
    const bSession = sessionFor(BOB, bConn)
    await handleClientFrame(bSession, JSON.stringify({ type: "join", cleanupId: CLEANUP }))
    await handleClientFrame(
      bSession,
      JSON.stringify({
        type: "ack",
        upToId: "44444444-4444-4444-4444-444444444444",
        cleanupId: CLEANUP,
      }),
    )
    const after = notifRepo.notifications.filter(
      (n) => n.userId === BOB && n.type === "cleanup_chat" && n.readAt === null,
    )
    expect(after).toHaveLength(0)
  })
})
