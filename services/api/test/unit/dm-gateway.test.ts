import { describe, it, expect, beforeEach } from "vitest"
import {
  handleClientFrame,
  type GatewayDeps,
  type GatewayDmDeps,
  type GatewaySession,
} from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatPresence } from "../../src/adapters/chat-presence.js"
import { MockConnection } from "../helpers/chat.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import {
  WsServerMessageSchema,
  type ChatMessageDTO,
} from "@civfix/shared"

/**
 * DM routing through the WS gateway (handleClientFrame), mirroring chat-realtime.test.ts but for
 * roomKind:"dm". Asserts:
 *   - a participant can JOIN the dm room (namespaced dm:<thread> key) and gets a presence_snapshot carrying
 *     roomKind:"dm";
 *   - SEND persists via the dm seam and broadcasts to the OTHER participant (excludes the sender), with the
 *     DTO carrying cleanupId=threadId + roomKind:"dm"; the sender is acked;
 *   - a BLOCK (either direction) rejects join AND send with a FORBIDDEN error frame and persists nothing;
 *   - ACK with roomKind:"dm" routes to the dm read-state seam (not the cleanup one);
 *   - every outbound frame validates against the shared server schema.
 */

const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"
const CAROL = "33333333-3333-3333-3333-333333333333"

let chat: WsChatService
let pubsub: InMemoryChatPubSub
let presence: InMemoryChatPresence
let dmRepo: InMemoryDmRepository
let blocks: InMemoryBlocksRepository
let dmMarks: Array<{ threadId: string; userId: string; upToId: string }>
let cleanupMarks: Array<{ cleanupId: string; userId: string; upToId: string }>

/** Adapt the in-memory dm repo + blocks repo into the gateway's GatewayDmDeps (and capture markRead). */
function dmDeps(): GatewayDmDeps {
  return {
    isParticipant: (threadId, userId) => dmRepo.isParticipant(threadId, userId),
    peerOf: (threadId, userId) => Promise.resolve(dmRepo.peerOf(threadId, userId)),
    persist: (input) => dmRepo.persist(input),
    markRead: (threadId, userId, upToId) => {
      dmMarks.push({ threadId, userId, upToId })
      return Promise.resolve()
    },
  }
}

function depsFor(): GatewayDeps {
  return {
    chat,
    isMember: () => Promise.resolve(false), // no cleanup membership in these dm tests
    presence,
    dm: dmDeps(),
    isBlockedEitherWay: (a, b) => blocks.isBlockedEitherWay(a, b),
    markRead: (cleanupId, userId, upToId) => {
      cleanupMarks.push({ cleanupId, userId, upToId })
      return Promise.resolve()
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

function assertServerFrame(raw: string): void {
  const parsed = WsServerMessageSchema.safeParse(JSON.parse(raw))
  expect(parsed.success, `frame failed server schema: ${raw}`).toBe(true)
}

let THREAD: string

beforeEach(async () => {
  pubsub = new InMemoryChatPubSub()
  presence = new InMemoryChatPresence()
  blocks = new InMemoryBlocksRepository()
  dmRepo = new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
  dmRepo.registerUser({ id: ALICE, displayName: "Alice", handle: "alice" })
  dmRepo.registerUser({ id: BOB, displayName: "Bob", handle: "bob" })
  dmRepo.registerUser({ id: CAROL, displayName: "Carol", handle: "carol" })
  chat = new WsChatService({ repo: makeUnusedChatRepo(), pubsub })
  dmMarks = []
  cleanupMarks = []
  const thread = await dmRepo.openOrCreateThread(ALICE, BOB)
  THREAD = thread.id
})

/** A no-op cleanup ChatRepository (these tests never persist cleanup chat). */
function makeUnusedChatRepo() {
  return {
    insertMessage: () => Promise.reject(new Error("cleanup persist not expected in dm tests")),
    history: () => Promise.resolve({ items: [], nextCursor: null }),
    findMessage: () => Promise.resolve(null),
    toggleReaction: () => Promise.reject(new Error("cleanup reaction not expected in dm tests")),
    softDelete: () => Promise.reject(new Error("cleanup delete not expected in dm tests")),
  }
}

describe("DM gateway routing (join/send/ack/block)", () => {
  it("a participant joins the dm room and gets a presence_snapshot with roomKind:dm", async () => {
    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn)
    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }),
    )
    // The socket joined the NAMESPACED room key so dm and cleanup ids never collide.
    expect(aSession.joined.has(`dm:${THREAD}`)).toBe(true)
    const snaps = aConn.framesOfType("presence_snapshot")
    expect(snaps).toHaveLength(1)
    expect(snaps[0]).toMatchObject({ cleanupId: THREAD, roomKind: "dm" })
    for (const raw of aConn.sent) assertServerFrame(raw)
  })

  it("send persists via the dm seam and broadcasts to the peer (sender excluded, acked)", async () => {
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const aSession = sessionFor(ALICE, aConn)
    const bSession = sessionFor(BOB, bConn)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))
    await handleClientFrame(bSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))

    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: THREAD, roomKind: "dm", clientId: "c1", body: "hi bob" }),
    )

    // Bob (the peer) got the broadcast message; it carries cleanupId=thread + roomKind:dm.
    const bMsgs = bConn.framesOfType("message")
    expect(bMsgs).toHaveLength(1)
    const msg = (bMsgs[0] as { message: ChatMessageDTO }).message
    expect(msg.body).toBe("hi bob")
    expect(msg.cleanupId).toBe(THREAD)
    expect(msg.roomKind).toBe("dm")
    expect(msg.from.id).toBe(ALICE)

    // Alice (sender) got exactly one ack and NO echoed message (P1-2 exactly-once to sender).
    expect(aConn.framesOfType("ack")).toHaveLength(1)
    expect(aConn.framesOfType("message")).toHaveLength(0)

    // It was persisted in the dm store (history returns it).
    const page = await dmRepo.history(THREAD, undefined, 50)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.roomKind).toBe("dm")

    for (const raw of [...aConn.sent, ...bConn.sent]) assertServerFrame(raw)
  })

  it("a slur in the send body is rejected with a BLOCKED error frame (no persist/broadcast/ack)", async () => {
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const aSession = sessionFor(ALICE, aConn)
    const bSession = sessionFor(BOB, bConn)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))
    await handleClientFrame(bSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))

    await handleClientFrame(
      aSession,
      // A curated hate slur (App Store 1.2a gate). General profanity would pass; this does not.
      JSON.stringify({ type: "send", cleanupId: THREAD, roomKind: "dm", clientId: "c1", body: "you retard" }),
    )

    // Sender got a room-scoped BLOCKED error, NO ack, NO echoed message.
    const errs = aConn.framesOfType("error")
    expect(errs).toHaveLength(1)
    expect((errs[0] as { code: string }).code).toBe("BLOCKED")
    expect((errs[0] as { cleanupId?: string }).cleanupId).toBe(THREAD)
    expect(aConn.framesOfType("ack")).toHaveLength(0)
    expect(aConn.framesOfType("message")).toHaveLength(0)
    // The peer received nothing, and nothing was persisted.
    expect(bConn.framesOfType("message")).toHaveLength(0)
    expect((await dmRepo.history(THREAD, undefined, 50)).items).toHaveLength(0)
    for (const raw of [...aConn.sent, ...bConn.sent]) assertServerFrame(raw)
  })

  it("a slur in a CLEANUP (group) chat send is also BLOCKED — the gate is room-kind-agnostic", async () => {
    // The slur gate sits in the shared `send` path BEFORE the dm/cleanup kind split and BEFORE
    // authorizeRoom, so it fires for group chat exactly as for DMs (no join/membership needed to reach it).
    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn)
    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: THREAD, roomKind: "cleanup", clientId: "c1", body: "you retard" }),
    )
    const errs = aConn.framesOfType("error")
    expect(errs).toHaveLength(1)
    expect((errs[0] as { code: string }).code).toBe("BLOCKED")
    expect(aConn.framesOfType("ack")).toHaveLength(0)
    expect(aConn.framesOfType("message")).toHaveLength(0)
    for (const raw of aConn.sent) assertServerFrame(raw)
  })

  it("a clean send is unaffected by the slur gate (general profanity passes)", async () => {
    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))
    await handleClientFrame(
      aSession,
      // Slur-filter is slurs-only; everyday strong language is NOT blocked.
      JSON.stringify({ type: "send", cleanupId: THREAD, roomKind: "dm", clientId: "c1", body: "this is damn slow" }),
    )
    expect(aConn.framesOfType("error")).toHaveLength(0)
    expect(aConn.framesOfType("ack")).toHaveLength(1)
    expect((await dmRepo.history(THREAD, undefined, 50)).items).toHaveLength(1)
  })

  it("a block (either way) rejects dm join AND send and persists nothing", async () => {
    // Bob blocks Alice.
    await blocks.block(BOB, ALICE)

    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn)

    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))
    const joinErr = aConn.framesOfType("error")
    expect(joinErr).toHaveLength(1)
    expect((joinErr[0] as { code: string }).code).toBe("FORBIDDEN")
    expect(aSession.joined.size).toBe(0)

    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: THREAD, roomKind: "dm", clientId: "c", body: "let me in" }),
    )
    expect(aConn.framesOfType("error")).toHaveLength(2)
    expect(aConn.framesOfType("ack")).toHaveLength(0)
    expect((await dmRepo.history(THREAD, undefined, 50)).items).toHaveLength(0)
  })

  it("ack with roomKind:dm routes to the dm read-state seam (not the cleanup one)", async () => {
    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))
    await handleClientFrame(
      aSession,
      JSON.stringify({
        type: "ack",
        upToId: "44444444-4444-4444-4444-444444444444",
        cleanupId: THREAD,
        roomKind: "dm",
      }),
    )
    expect(dmMarks).toHaveLength(1)
    expect(dmMarks[0]).toMatchObject({ threadId: THREAD, userId: ALICE })
    // The cleanup read-state was NOT touched.
    expect(cleanupMarks).toHaveLength(0)
  })

  it("ack with NO room fields falls back to the socket's first joined room (dm)", async () => {
    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))
    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "ack", upToId: "44444444-4444-4444-4444-444444444444" }),
    )
    // The only joined room is the dm thread, so the ack routes to the dm seam.
    expect(dmMarks).toHaveLength(1)
    expect(dmMarks[0]).toMatchObject({ threadId: THREAD, userId: ALICE })
    expect(cleanupMarks).toHaveLength(0)
  })

  it("a NON-participant's dm ack is ignored (read-state write is participation-gated)", async () => {
    // Carol is not in the Alice<->Bob thread. An ack carrying that thread id must NOT write dm_read_state
    // for her — the gateway gates the markRead on peerOf (the M1 authorization fix). She need not even
    // have joined; an attacker would just send the frame.
    const cConn = new MockConnection("C")
    const cSession = sessionFor(CAROL, cConn)
    await handleClientFrame(
      cSession,
      JSON.stringify({
        type: "ack",
        upToId: "44444444-4444-4444-4444-444444444444",
        cleanupId: THREAD,
        roomKind: "dm",
      }),
    )
    expect(dmMarks).toHaveLength(0)
    expect(cleanupMarks).toHaveLength(0)
  })
})
