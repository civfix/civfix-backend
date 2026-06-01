import { describe, it, expect, beforeEach } from "vitest"
import {
  handleClientFrame,
  type GatewaySession,
  type GatewayDeps,
} from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatRepository, MockConnection } from "../helpers/chat.js"
import {
  WsClientMessageSchema,
  WsServerMessageSchema,
  type ChatMessageDTO,
} from "@civfix/shared"

/**
 * THE PHASE-1 DONE-CRITERION, proven locally: two devices chat in real time.
 *
 * This drives the gateway's frame handler (handleClientFrame) with TWO mock ChatConnections through the
 * REAL WsChatService over an in-memory pub/sub (the same fan-out wiring as Redis, minus the network). It
 * asserts:
 *   - A and B (both members) join room R; A sends a message;
 *   - B's send() receives the broadcast {type:"message"} frame (A -> B flows);
 *   - A receives an {type:"ack"} with its clientId and the persisted message (optimistic reconcile);
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

/** Build a fresh gateway session for a user over a mock connection. */
function sessionFor(userId: string, conn: MockConnection): GatewaySession {
  const deps: GatewayDeps = { chat, isMember: memberOf }
  return { userId, conn, joined: new Set<string>(), deps }
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

    // Both sockets are now in the local room and each got a presence(join) frame for itself.
    expect(chat.roomSize(ROOM)).toBe(2)
    expect(aConn.framesOfType("presence")).toHaveLength(1)
    expect(bConn.framesOfType("presence")).toHaveLength(1)

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
    expect(broadcast.message.from.id).toBe(ALICE)
    expect(broadcast.message.cleanupId).toBe(ROOM)

    // ---- A received an {type:"ack"} carrying its clientId + the persisted message ----
    const aAcks = aConn.framesOfType("ack")
    expect(aAcks).toHaveLength(1)
    const ack = aAcks[0]! as { type: "ack"; clientId: string; message: ChatMessageDTO }
    expect(ack.clientId).toBe(clientId)
    expect(ack.message.id).toBe(broadcast.message.id)
    expect(ack.message.body).toBe("hello bob")

    // A also receives the broadcast (its own message, e.g. for multi-device) - that is fine and valid.
    // Validate EVERY outbound frame on both sockets against the server schema.
    for (const raw of [...aConn.sent, ...bConn.sent]) assertServerFrame(raw)

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
    const session: GatewaySession = { userId: ALICE, conn, joined: new Set<string>(), deps }

    // An ack before joining any room marks nothing.
    await handleClientFrame(session, JSON.stringify({ type: "ack", upToId: ROOM }))
    expect(marks).toHaveLength(0)

    // After joining, an ack marks THAT room read.
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(session, JSON.stringify({ type: "ack", upToId: "55555555-5555-5555-5555-555555555555" }))
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ cleanupId: ROOM, userId: ALICE })
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
