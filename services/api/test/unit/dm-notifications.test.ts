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

/**
 * DM bell-notification wiring through the WS gateway (issue #42, scope b/a):
 *   - a dm SEND creates a `type:"dm"` notification for the PEER (recipient), NOT the sender, and sends the
 *     inline push (gated by prefs default→true under the master push switch);
 *   - the notification is SUPPRESSED when the recipient is ACTIVELY viewing the dm room (present on the
 *     namespaced dm:<thread> presence key) — the literal #42 complaint;
 *   - reading the DM conversation (an ack the gateway routes to dm.markRead) CLEARS the `dm` notification;
 *   - reading a cleanup conversation (an ack the gateway routes to the cleanup markRead) CLEARS its
 *     `cleanup_chat` notification.
 *
 * The gateway hook (onDmDelivered) + the presence suppression are the unit under test; the notification copy
 * (title/body) lives in chat.routes, so this test wires a faithful hook that calls createNotification with
 * the same `type:"dm"` + `/messages/dm/<thread>` link the route uses.
 */

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

/** A faithful copy of chat.routes' onDmDelivered: a `type:"dm"` notification linking to the dm thread. */
const onDmDelivered: OnDmDelivered = async (threadId, recipientId, message) => {
  await notifications.createNotification(recipientId, {
    type: "dm",
    title: message.from.handle ? `@${message.from.handle}` : message.from.name,
    body: typeof message.body === "string" ? message.body : "Sent you a message",
    link: `/messages/dm/${threadId}`,
  })
}

function dmDeps(): GatewayDmDeps {
  return {
    isParticipant: (threadId, userId) => dmRepo.isParticipant(threadId, userId),
    peerOf: (threadId, userId) => Promise.resolve(dmRepo.peerOf(threadId, userId)),
    persist: (input) => dmRepo.persist(input),
    // Mirror chat.routes' dm markRead cross-update: advance the watermark AND clear the reader's dm
    // notifications for this thread.
    markRead: async (threadId, userId) => {
      await dmRepo.markRead(threadId, userId, new Date())
      await notifications.clearByTypeAndLink(userId, "dm", `/messages/dm/${threadId}`)
    },
  }
}

function depsFor(): GatewayDeps {
  return {
    chat,
    // Cleanup membership: Alice and Bob are both members of CLEANUP (so the cleanup ack/markRead runs).
    isMember: (cleanupId, userId) =>
      Promise.resolve(cleanupId === CLEANUP && (userId === ALICE || userId === BOB)),
    presence,
    dm: dmDeps(),
    isBlockedEitherWay: (a, b) => blocks.isBlockedEitherWay(a, b),
    onDmDelivered,
    // Cleanup markRead cross-update: clear the reader's cleanup_chat notifications for this cleanup.
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
  }
}

/** All unread dm-notification rows for a user. */
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
    // The onDmDelivered hook is fired fire-and-forget after the ack; let the microtasks flush.
    await new Promise((r) => setTimeout(r, 0))

    // Bob (the peer) got a `dm` notification; Alice (the sender) got none.
    const bobNotifs = unreadDmNotifs(BOB)
    expect(bobNotifs).toHaveLength(1)
    expect(bobNotifs[0]!.link).toBe(`/messages/dm/${THREAD}`)
    expect(bobNotifs[0]!.title).toBe("@alice")
    expect(bobNotifs[0]!.body).toBe("hi bob")
    expect(unreadDmNotifs(ALICE)).toHaveLength(0)

    // The inline push went to Bob (default prefs → true under the master push switch).
    expect(push.sent.some((p) => p.userId === BOB)).toBe(true)
    expect(push.sent.some((p) => p.userId === ALICE)).toBe(false)
  })

  it("SUPPRESSES the notification when the recipient is actively viewing the dm room", async () => {
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const aSession = sessionFor(ALICE, aConn)
    const bSession = sessionFor(BOB, bConn)
    // Bob is actively in the room (joined → present on dm:<thread>).
    await handleClientFrame(bSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))

    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: THREAD, roomKind: "dm", clientId: "c1", body: "you there?" }),
    )
    await new Promise((r) => setTimeout(r, 0))

    // No bell notification (and no push) for Bob — he is reading it live.
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

    // Bob opens + reads the conversation: a dm ack routes to dm.markRead, which clears his `dm` notifs.
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
    // Seed an admin "Cleanup update" broadcast for Bob (links to /cleanups/<id>).
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

    // Bob reads the cleanup chat: a cleanup ack routes to the cleanup markRead, which clears the row.
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
