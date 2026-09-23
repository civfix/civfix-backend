import { describe, it, expect, beforeEach } from "vitest"
import { handleClientFrame, type GatewaySession, type GatewayDeps } from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatPresence } from "../../src/adapters/chat-presence.js"
import { InMemoryChatRepository, MockConnection } from "../helpers/chat.js"
import { WsServerMessageSchema } from "@civfix/shared"

/**
 * Typing indicators: a member's typing frame fans a {type:"typing"} to the OTHER members (the sender is
 * excluded), a non-member cannot signal typing, the fan-out is throttled, and the emitted frame validates
 * against the shared server schema.
 */

const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"
const MALLORY = "33333333-3333-3333-3333-333333333333"

function memberOf(cleanupId: string, userId: string): Promise<boolean> {
  return Promise.resolve(cleanupId === ROOM && (userId === ALICE || userId === BOB))
}

let chat: WsChatService
let presence: InMemoryChatPresence

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

beforeEach(() => {
  presence = new InMemoryChatPresence()
  chat = new WsChatService({ repo: new InMemoryChatRepository(), pubsub: new InMemoryChatPubSub() })
})

describe("typing fan-out", () => {
  it("delivers a typing frame to the OTHER member and excludes the typist", async () => {
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const aSession = sessionFor(ALICE, aConn)
    const bSession = sessionFor(BOB, bConn)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(bSession, JSON.stringify({ type: "join", cleanupId: ROOM }))

    await handleClientFrame(aSession, JSON.stringify({ type: "typing", cleanupId: ROOM }))

    // B sees Alice typing; A never sees its own typing echoed.
    const bTyping = bConn.framesOfType("typing")
    expect(bTyping).toHaveLength(1)
    expect(bTyping[0]).toMatchObject({ type: "typing", cleanupId: ROOM, userId: ALICE })
    expect(aConn.framesOfType("typing")).toHaveLength(0)

    // The emitted frame is a valid server frame.
    expect(WsServerMessageSchema.safeParse(bTyping[0]).success).toBe(true)
  })

  it("rejects typing from a non-member and fans out nothing", async () => {
    const aConn = new MockConnection("A")
    const mConn = new MockConnection("M")
    const aSession = sessionFor(ALICE, aConn)
    const mSession = sessionFor(MALLORY, mConn)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))

    await handleClientFrame(mSession, JSON.stringify({ type: "typing", cleanupId: ROOM }))

    expect(mConn.framesOfType("error")).toHaveLength(1)
    expect((mConn.framesOfType("error")[0] as { code: string }).code).toBe("FORBIDDEN")
    // The member in the room saw no typing from the non-member.
    expect(aConn.framesOfType("typing")).toHaveLength(0)
  })

  it("throttles rapid typing frames from the same connection", async () => {
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const aSession = sessionFor(ALICE, aConn)
    const bSession = sessionFor(BOB, bConn)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(bSession, JSON.stringify({ type: "join", cleanupId: ROOM }))

    // Three typing frames in immediate succession (well within the throttle window) -> one fan-out.
    await handleClientFrame(aSession, JSON.stringify({ type: "typing", cleanupId: ROOM }))
    await handleClientFrame(aSession, JSON.stringify({ type: "typing", cleanupId: ROOM }))
    await handleClientFrame(aSession, JSON.stringify({ type: "typing", cleanupId: ROOM }))
    expect(bConn.framesOfType("typing")).toHaveLength(1)
  })
})
