import { describe, it, expect, beforeEach, vi } from "vitest"
import { handleClientFrame, type GatewaySession, type GatewayDeps } from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub, chatChannel } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatPresence } from "../../src/adapters/chat-presence.js"
import { InMemoryChatRepository, MockConnection } from "../helpers/chat.js"
import { WsClientMessageSchema, WsServerMessageSchema, type ChatMessageDTO } from "@civfix/shared"

/**
 * THE PHASE-1 DONE-CRITERION, proven locally: two devices chat in real time.
 *
 * This drives the gateway's frame handler (handleClientFrame) with TWO mock ChatConnections through the
 * REAL WsChatService over an in-memory pub/sub (the same fan-out wiring as Redis, minus the network). It
 * asserts:
 *   - A and B (both members) join room R; A sends a message;
 *   - B's send() receives the broadcast {type:"message"} frame (A -> B flows);
 *   - A receives an {type:"ack"} with its clientId and the persisted message (optimistic reconcile) and
 *     EXACTLY ONE total frame for the send (no echoed {type:"message"} - P1-2 exactly-once to sender);
 *   - the message was persisted (history returns it);
 *   - a NON-member is rejected on join AND cannot send (membership gate);
 *   - every inbound/outbound frame validates against the shared WS schemas.
 */

const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"
const MALLORY = "33333333-3333-3333-3333-333333333333"

/** Members of ROOM: Alice + Bob. Mallory is not a member. */
function memberOf(cleanupId: string, userId: string): Promise<boolean> {
  const members = new Set([ALICE, BOB])
  return Promise.resolve(cleanupId === ROOM && members.has(userId))
}

let chat: WsChatService
let pubsub: InMemoryChatPubSub
let repo: InMemoryChatRepository
let presence: InMemoryChatPresence

/** Build a fresh gateway session for a user over a mock connection. */
function sessionFor(userId: string, conn: MockConnection): GatewaySession {
  const deps: GatewayDeps = { chat, isMember: memberOf, presence }
  return {
    userId,
    conn,
    joined: new Set<string>(),
    typingThrottle: new Map<string, number>(),
    deps,
  }
}

/** Assert a raw frame string parses as a valid client frame (outbound-from-client direction). */
function assertClientFrame(raw: string): void {
  expect(WsClientMessageSchema.safeParse(JSON.parse(raw)).success).toBe(true)
}

/** Assert a raw frame string parses as a valid server frame (outbound-to-client direction). */
function assertServerFrame(raw: string): void {
  const parsed = WsServerMessageSchema.safeParse(JSON.parse(raw))
  expect(parsed.success, `frame failed server schema: ${raw}`).toBe(true)
}

beforeEach(() => {
  pubsub = new InMemoryChatPubSub()
  repo = new InMemoryChatRepository()
  presence = new InMemoryChatPresence()
  repo.registerSender({ id: ALICE, displayName: "Alice" })
  repo.registerSender({ id: BOB, displayName: "Bob" })
  chat = new WsChatService({ repo, pubsub })
})

describe("two-device real-time chat (A -> B with ack + persistence)", () => {
  it("delivers A's message to B, acks A, and persists it", async () => {
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const aSession = sessionFor(ALICE, aConn)
    const bSession = sessionFor(BOB, bConn)

    // Both join room R (both members). The join frames are valid client frames.
    const joinFrameA = JSON.stringify({ type: "join", cleanupId: ROOM })
    const joinFrameB = JSON.stringify({ type: "join", cleanupId: ROOM })
    assertClientFrame(joinFrameA)
    assertClientFrame(joinFrameB)
    await handleClientFrame(aSession, joinFrameA)
    await handleClientFrame(bSession, joinFrameB)

    // Both sockets are in the local room. On join each got a presence_snapshot of who was online; A (who
    // joined first) then also got a presence(join) DELTA for B, while B (joined last) got no delta.
    expect(chat.roomSize(ROOM)).toBe(2)
    expect(aConn.framesOfType("presence_snapshot")).toHaveLength(1)
    expect(bConn.framesOfType("presence_snapshot")).toHaveLength(1)
    expect(aConn.framesOfType("presence")).toHaveLength(1)
    expect(bConn.framesOfType("presence")).toHaveLength(0)
    // B's snapshot (joined last) lists both online members; A's (joined alone) listed only itself.
    const bSnap = bConn.framesOfType("presence_snapshot")[0]! as { userIds: string[] }
    expect([...bSnap.userIds].sort()).toEqual([ALICE, BOB].sort())

    // A sends a message with a client-generated id.
    const clientId = "client-temp-1"
    const sendFrame = JSON.stringify({
      type: "send",
      cleanupId: ROOM,
      clientId,
      body: "hello bob",
    })
    assertClientFrame(sendFrame)
    await handleClientFrame(aSession, sendFrame)

    // ---- B received the broadcast {type:"message"} (the A -> B real-time path) ----
    const bMessages = bConn.framesOfType("message")
    expect(bMessages).toHaveLength(1)
    const broadcast = bMessages[0]! as { type: "message"; message: ChatMessageDTO }
    expect(broadcast.message.body).toBe("hello bob")
    // This is an Alice-authored chat send, not a sender-less SYSTEM message, so `from` is always present
    // here; assert that before narrowing so the intent (author == Alice) stays explicit.
    expect(broadcast.message.from).toBeTruthy()
    expect(broadcast.message.from?.id).toBe(ALICE)
    expect(broadcast.message.cleanupId).toBe(ROOM)

    // ---- A received an {type:"ack"} carrying its clientId + the persisted message ----
    const aAcks = aConn.framesOfType("ack")
    expect(aAcks).toHaveLength(1)
    const ack = aAcks[0]! as { type: "ack"; clientId: string; message: ChatMessageDTO }
    expect(ack.clientId).toBe(clientId)
    expect(ack.message.id).toBe(broadcast.message.id)
    expect(ack.message.body).toBe("hello bob")

    // ---- P1-2: the sender receives EXACTLY ONE frame for the send (the ack), NOT the broadcast ----
    // A's socket is in the room, but it is excluded from the broadcast fan-out, so it never gets a
    // {type:"message"} echo of its own message. The ack is its only copy (exactly-once to the sender).
    expect(aConn.framesOfType("message")).toHaveLength(0)
    // Total frames A received during the send: just the one ack (the presence_snapshot + presence(join)
    // deltas came earlier, during the joins).
    const aFramesAfterJoin = aConn.frames.filter(
      (f) => f.type !== "presence" && f.type !== "presence_snapshot",
    )
    expect(aFramesAfterJoin).toHaveLength(1)
    expect(aFramesAfterJoin[0]!.type).toBe("ack")

    // Validate EVERY outbound frame on both sockets against the server schema (the broadcast frame B got
    // must NOT carry the internal excludeConnId hint - it is stripped before the wire).
    for (const raw of [...aConn.sent, ...bConn.sent]) assertServerFrame(raw)
    expect(
      JSON.parse(bConn.sent.find((s) => JSON.parse(s).type === "message")!),
    ).not.toHaveProperty("excludeConnId")

    // ---- The message was persisted: history returns it ----
    const page = await chat.history(ROOM, undefined, 50)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.id).toBe(broadcast.message.id)
    expect(page.items[0]!.body).toBe("hello bob")
    expect(repo.count(ROOM)).toBe(1)
  })

  it("rejects a NON-member on join and on send (membership gate)", async () => {
    const mConn = new MockConnection("M")
    const mSession = sessionFor(MALLORY, mConn)

    // Join is rejected with an error frame; the room does not admit Mallory.
    await handleClientFrame(mSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    const joinErrors = mConn.framesOfType("error")
    expect(joinErrors).toHaveLength(1)
    expect((joinErrors[0] as { code: string }).code).toBe("FORBIDDEN")
    expect(chat.roomSize(ROOM)).toBe(0)
    expect(mSession.joined.has(ROOM)).toBe(false)

    // Send is rejected too; nothing is persisted and no message is broadcast.
    await handleClientFrame(
      mSession,
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "x", body: "intrude" }),
    )
    const errorsAfterSend = mConn.framesOfType("error")
    expect(errorsAfterSend).toHaveLength(2)
    expect(mConn.framesOfType("message")).toHaveLength(0)
    expect(mConn.framesOfType("ack")).toHaveLength(0)
    expect(repo.count(ROOM)).toBe(0)

    // Every outbound frame (the two error frames) is a valid server frame.
    for (const raw of mConn.sent) assertServerFrame(raw)
  })

  it("a member who has not joined the room still cannot be reached by a broadcast until they join", async () => {
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const aSession = sessionFor(ALICE, aConn)
    const bSession = sessionFor(BOB, bConn)

    // Only A joins; B is a member but has not opened the room.
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c1", body: "anyone?" }),
    )

    // B received nothing (not in the room), but the message is persisted and A is acked.
    expect(bConn.framesOfType("message")).toHaveLength(0)
    expect(aConn.framesOfType("ack")).toHaveLength(1)
    expect(repo.count(ROOM)).toBe(1)

    // Now B joins and a SECOND message reaches B.
    await handleClientFrame(bSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c2", body: "now you see me" }),
    )
    const bMsgs = bConn.framesOfType("message")
    expect(bMsgs).toHaveLength(1)
    expect((bMsgs[0] as { message: ChatMessageDTO }).message.body).toBe("now you see me")
  })

  it("leaving the room stops further delivery and unsubscribes when empty", async () => {
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const aSession = sessionFor(ALICE, aConn)
    const bSession = sessionFor(BOB, bConn)

    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(bSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    expect(chat.roomSize(ROOM)).toBe(2)

    // B leaves.
    await handleClientFrame(bSession, JSON.stringify({ type: "leave", cleanupId: ROOM }))
    expect(chat.roomSize(ROOM)).toBe(1)

    // A sends; B (left) receives nothing further.
    const beforeB = bConn.framesOfType("message").length
    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c3", body: "bye" }),
    )
    expect(bConn.framesOfType("message").length).toBe(beforeB)

    // A leaves -> the room empties and the pub/sub channel is unsubscribed.
    await handleClientFrame(aSession, JSON.stringify({ type: "leave", cleanupId: ROOM }))
    expect(chat.roomSize(ROOM)).toBe(0)
    expect(pubsub.channelCount).toBe(0)
  })

  it("close() unsubscribes every open room but leaves the INJECTED pub/sub open (it does not own it)", async () => {
    // OWNERSHIP CONTRACT: di.ts wires ONE RedisChatPubSub into BOTH this service and RedisUserChannel and
    // closes that layer itself, AFTER both consumers. So close() must NOT close the pub/sub it was handed -
    // that would disconnect the shared subscriber connection out from under the user channel. What close()
    // DOES owe is tearing down every room subscription it opened: a leaked room subscription keeps
    // delivering pub/sub frames to sockets that are gone.
    const closeSpy = vi.spyOn(pubsub, "close")

    // A co-consumer subscribed on the SAME pub/sub layer (RedisUserChannel in production, sharing the one
    // dedicated subscriber connection). Its delivery must survive the chat service's shutdown.
    const coConsumer = vi.fn()
    await pubsub.subscribe("user:co-consumer", coConsumer)

    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    expect(chat.roomSize(ROOM)).toBe(1)
    expect(pubsub.channelCount).toBe(2) // chat:<ROOM> + the co-consumer's channel

    await chat.close()

    // Rooms are dropped and REALLY unsubscribed (no leaked handle): only the co-consumer's channel is left,
    // and a frame published on the room's channel now reaches nobody (a leaked subscription would pass this
    // non-envelope payload straight through to A's socket).
    expect(chat.roomSize(ROOM)).toBe(0)
    expect(pubsub.channelCount).toBe(1)
    const framesBefore = aConn.sent.length
    await pubsub.publish(chatChannel(ROOM), "post-close-frame")
    expect(aConn.sent).toHaveLength(framesBefore)

    // The injected layer itself is untouched: never closed, and the co-consumer still receives.
    expect(closeSpy).not.toHaveBeenCalled()
    await pubsub.publish("user:co-consumer", "still-live")
    expect(coConsumer).toHaveBeenCalledWith("still-live")
  })

  it("container-level teardown closes the shared pub/sub exactly once, after the chat service", async () => {
    // The other half of the contract: the subscriber connection still MUST be closed at shutdown (otherwise
    // it keeps the event loop alive past SIGTERM) - by the owner, i.e. the DI container, after every
    // consumer of it has closed. This pins di.ts's order: consumers first, then the shared pub/sub.
    const coConsumer = vi.fn()
    await pubsub.subscribe("user:co-consumer", coConsumer)

    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    expect(chat.roomSize(ROOM)).toBe(1)

    const chatCloseSpy = vi.spyOn(chat, "close")
    const pubsubCloseSpy = vi.spyOn(pubsub, "close")

    // di.ts close(): userChannel.close() -> chatService.close() -> sharedPubSub.close().
    await chat.close()
    await pubsub.close()

    expect(pubsubCloseSpy).toHaveBeenCalledTimes(1)
    expect(chatCloseSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      pubsubCloseSpy.mock.invocationCallOrder[0]!,
    )

    // Nothing survives shutdown: no room, no channel, no delivery on either side.
    expect(chat.roomSize(ROOM)).toBe(0)
    expect(pubsub.channelCount).toBe(0)
    const framesBefore = aConn.sent.length
    await pubsub.publish(chatChannel(ROOM), "post-shutdown-frame")
    await pubsub.publish("user:co-consumer", "post-shutdown-signal")
    expect(aConn.sent).toHaveLength(framesBefore)
    expect(coConsumer).not.toHaveBeenCalled()
  })
})

describe("ack updates read state for the open room", () => {
  it("marks the joined room read via markRead", async () => {
    const marks: Array<{ cleanupId: string; userId: string; upToId: string }> = []
    const conn = new MockConnection()
    const deps: GatewayDeps = {
      chat,
      isMember: memberOf,
      markRead: (cleanupId, userId, upToId) => {
        marks.push({ cleanupId, userId, upToId })
        return Promise.resolve()
      },
    }
    const session: GatewaySession = {
      userId: ALICE,
      conn,
      joined: new Set<string>(),
      typingThrottle: new Map<string, number>(),
      deps,
    }

    // An ack before joining any room marks nothing.
    await handleClientFrame(session, JSON.stringify({ type: "ack", upToId: ROOM }))
    expect(marks).toHaveLength(0)

    // After joining, an ack marks THAT room read.
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(
      session,
      JSON.stringify({ type: "ack", upToId: "55555555-5555-5555-5555-555555555555" }),
    )
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ cleanupId: ROOM, userId: ALICE })
  })
})

describe("history `before` cursor is room-scoped (P1-5)", () => {
  it("a cursor id from another room does not seek/leak into this room (in-memory parity)", async () => {
    const roomA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    const roomB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    repo.registerSender({ id: ALICE, displayName: "Alice" })

    // Room A has 3 messages; room B has 1.
    const a1 = await repo.insertMessage({ cleanupId: roomA, userId: ALICE, body: "a1" }, "a1-id")
    const a2 = await repo.insertMessage({ cleanupId: roomA, userId: ALICE, body: "a2" }, "a2-id")
    const a3 = await repo.insertMessage({ cleanupId: roomA, userId: ALICE, body: "a3" }, "a3-id")
    const b1 = await repo.insertMessage({ cleanupId: roomB, userId: ALICE, body: "b1" }, "b1-id")

    // Paging room A with room B's message id as the `before` cursor: the foreign id is not found in
    // room A, so we get room A's newest page (a3, a2) - never b1, never a B-timestamp-carved window.
    const page = await chat.history(roomA, b1.id, 2)
    expect(page.items.map((m) => m.id)).toEqual([a3.id, a2.id])
    expect(page.items.every((m) => m.cleanupId === roomA)).toBe(true)
    expect(page.items.some((m) => m.id === b1.id)).toBe(false)

    // Control: a valid in-room cursor pages correctly.
    const within = await chat.history(roomA, a3.id, 2)
    expect(within.items.map((m) => m.id)).toEqual([a2.id, a1.id])
  })
})

describe("malformed frames never crash the socket", () => {
  it("answers a non-JSON frame with an error frame", async () => {
    const conn = new MockConnection()
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, "not json{{{")
    const errors = conn.framesOfType("error")
    expect(errors).toHaveLength(1)
    expect((errors[0] as { code: string }).code).toBe("BAD_FRAME")
    assertServerFrame(conn.sent[0]!)
  })

  it("answers a schema-invalid frame (unknown type) with an error frame", async () => {
    const conn = new MockConnection()
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, JSON.stringify({ type: "explode", cleanupId: ROOM }))
    const errors = conn.framesOfType("error")
    expect(errors).toHaveLength(1)
    expect((errors[0] as { code: string }).code).toBe("BAD_FRAME")
  })

  it("answers a send with a missing body (schema-invalid) with an error frame and persists nothing", async () => {
    const conn = new MockConnection()
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(
      session,
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c" }),
    )
    expect(conn.framesOfType("error")).toHaveLength(1)
    expect(repo.count(ROOM)).toBe(0)
  })
})
