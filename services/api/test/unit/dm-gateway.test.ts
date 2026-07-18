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
let openMarks: Array<{ kind: string; id: string; userId: string }>
let signals: Array<{ userId: string; topic: string; id?: string | undefined }>

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
    isMember: () => Promise.resolve(false),
    presence,
    dm: dmDeps(),
    isBlockedEitherWay: (a, b) => blocks.isBlockedEitherWay(a, b),
    markRead: (cleanupId, userId, upToId) => {
      cleanupMarks.push({ cleanupId, userId, upToId })
      return Promise.resolve()
    },
    markReadOnOpen: (kind, id, userId) => {
      openMarks.push({ kind, id, userId })
      return Promise.resolve()
    },
    userChannel: {
      subscribeUser: () => Promise.resolve(async () => {}),
      publishToUser: (userId, signal) => {
        signals.push({ userId, topic: signal.topic, id: signal.id })
        return Promise.resolve()
      },
      publishToUsers: () => Promise.resolve(),
      close: () => Promise.resolve(),
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
  openMarks = []
  signals = []
  const thread = await dmRepo.openOrCreateThread(ALICE, BOB)
  THREAD = thread.id
})

function makeUnusedChatRepo() {
  return {
    insertMessage: () => Promise.reject(new Error("cleanup persist not expected in dm tests")),
    history: () => Promise.resolve({ items: [], nextCursor: null }),
    findMessage: () => Promise.resolve(null),
    toggleReaction: () => Promise.reject(new Error("cleanup reaction not expected in dm tests")),
    softDelete: () => Promise.reject(new Error("cleanup delete not expected in dm tests")),
    findMessageMeta: () => Promise.resolve(null),
    editMessage: () => Promise.reject(new Error("cleanup edit not expected in dm tests")),
    editReportMessage: () => Promise.reject(new Error("report edit not expected in dm tests")),
    reportHistory: () => Promise.resolve({ items: [], nextCursor: null }),
    findReportMessage: () => Promise.resolve(null),
    softDeleteReport: () => Promise.reject(new Error("report delete not expected in dm tests")),
    countReportMessages: () => Promise.resolve(0),
    setPinned: () => Promise.reject(new Error("cleanup pin not expected in dm tests")),
    setReportPinned: () => Promise.reject(new Error("report pin not expected in dm tests")),
    listPins: () => Promise.resolve([]),
    listReportPins: () => Promise.resolve([]),
    groupHistory: () => Promise.resolve({ items: [], nextCursor: null }),
    findGroupMessage: () => Promise.resolve(null),
    softDeleteGroup: () => Promise.reject(new Error("group delete not expected in dm tests")),
    setGroupPinned: () => Promise.reject(new Error("group pin not expected in dm tests")),
    listGroupPins: () => Promise.resolve([]),
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

    const bMsgs = bConn.framesOfType("message")
    expect(bMsgs).toHaveLength(1)
    const msg = (bMsgs[0] as { message: ChatMessageDTO }).message
    expect(msg.body).toBe("hi bob")
    expect(msg.cleanupId).toBe(THREAD)
    expect(msg.roomKind).toBe("dm")
    // DM messages always have an author (no sender-less SYSTEM messages on the dm path); assert that
    // before narrowing so the intent (author == Alice) stays explicit.
    expect(msg.from).toBeTruthy()
    expect(msg.from?.id).toBe(ALICE)

    expect(aConn.framesOfType("ack")).toHaveLength(1)
    expect(aConn.framesOfType("message")).toHaveLength(0)

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
      JSON.stringify({ type: "send", cleanupId: THREAD, roomKind: "dm", clientId: "c1", body: "you retard" }),
    )

    const errs = aConn.framesOfType("error")
    expect(errs).toHaveLength(1)
    expect((errs[0] as { code: string }).code).toBe("BLOCKED")
    expect((errs[0] as { cleanupId?: string }).cleanupId).toBe(THREAD)
    expect(aConn.framesOfType("ack")).toHaveLength(0)
    expect(aConn.framesOfType("message")).toHaveLength(0)
    expect(bConn.framesOfType("message")).toHaveLength(0)
    expect((await dmRepo.history(THREAD, undefined, 50)).items).toHaveLength(0)
    for (const raw of [...aConn.sent, ...bConn.sent]) assertServerFrame(raw)
  })

  it("a slur in a CLEANUP (group) chat send is also BLOCKED — the gate is room-kind-agnostic", async () => {
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
      JSON.stringify({ type: "send", cleanupId: THREAD, roomKind: "dm", clientId: "c1", body: "this is damn slow" }),
    )
    expect(aConn.framesOfType("error")).toHaveLength(0)
    expect(aConn.framesOfType("ack")).toHaveLength(1)
    expect((await dmRepo.history(THREAD, undefined, 50)).items).toHaveLength(1)
  })

  it("a block (either way) rejects dm join AND send and persists nothing", async () => {
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
    expect(dmMarks).toHaveLength(1)
    expect(dmMarks[0]).toMatchObject({ threadId: THREAD, userId: ALICE })
    expect(cleanupMarks).toHaveLength(0)
  })

  it("a NON-participant's dm ack is ignored (read-state write is participation-gated)", async () => {
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

  it("opening (join) a dm marks the room read on open and self-signals the reader's threads (#42)", async () => {
    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))
    expect(openMarks).toEqual([{ kind: "dm", id: THREAD, userId: ALICE }])
    await new Promise((r) => setTimeout(r, 0))
    expect(signals).toContainEqual({ userId: ALICE, topic: "threads", id: THREAD })
  })

  it("a dm ack self-signals the reader's threads so the badge refetches after the watermark (#42)", async () => {
    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: THREAD, roomKind: "dm" }))
    signals.length = 0
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
    expect(signals).toContainEqual({ userId: ALICE, topic: "threads", id: THREAD })
  })

  it("a NON-participant's dm ack neither marks read nor self-signals (the signal is gated too)", async () => {
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
    expect(signals).toHaveLength(0)
  })
})
