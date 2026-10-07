// Characterization of the gateway send path (ws/frame-handler.ts handleSend, reached through
// handleClientFrame) and of routes/chat-gateway-wiring.ts wireChatGateway, pinned ahead of a
// behavior-neutral split of both functions. Frames are compared as exact JSON so any drift in
// code, message, room stamping or field set fails here.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import { AppError, MESSAGE_BODY_MAX, type ChatMessageDTO } from "@civfix/shared"
import type { Container } from "../../src/di.js"
import type {
  GatewayDeps,
  GatewayGroupChat,
  GatewayReportChat,
  GatewaySession,
  RegisterGatewayOptions,
} from "../../src/ws/types.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatPresence } from "../../src/adapters/chat-presence.js"
import { InMemoryChatReadState } from "../../src/services/threads-service.js"
import {
  InMemorySendDedupeStore,
  makeSendResilience,
  sendDedupeKey,
  type SendDedupeStore,
  type SendReservation,
} from "../../src/ws/send-resilience.js"
import { wsUpgradeRateLimitKey } from "../../src/plugins/rate-limit.js"
import type { ChatGroupRepository } from "../../src/services/chat-group-repository.js"
import type { ReportChatRepository } from "../../src/services/report-chat-repository.js"
import type { ConversationMutesRepository } from "../../src/services/conversation-mutes-repository.js"
import type { NotificationService } from "../../src/services/notification-service.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import {
  InMemoryChatRepository,
  InMemoryThreadsRepository,
  MockConnection,
} from "../helpers/chat.js"

const { captured } = vi.hoisted(() => ({
  captured: { opts: undefined as RegisterGatewayOptions | undefined },
}))

vi.mock("../../src/ws/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ws/gateway.js")>()
  return {
    ...actual,
    registerChatGateway: (_app: unknown, opts: RegisterGatewayOptions) => {
      captured.opts = opts
    },
  }
})

const { handleClientFrame } = await import("../../src/ws/gateway.js")
const { wireChatGateway } = await import("../../src/routes/chat-gateway-wiring.js")

const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const OTHER_ROOM = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const REPORT = "cccccccc-cccc-cccc-cccc-cccccccccccc"
const GROUP = "dddddddd-dddd-dddd-dddd-dddddddddddd"
const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"
const MALLORY = "99999999-9999-9999-9999-999999999999"

const SUSPENDED_TEXT =
  "This account is suspended. You can still read civfix, but you cannot post, message, or change anything until the suspension is lifted."

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const send = (fields: Record<string, unknown>): string =>
  JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c1", body: "hello", ...fields })

const join = (cleanupId: string, roomKind?: string): string =>
  JSON.stringify({ type: "join", cleanupId, ...(roomKind ? { roomKind } : {}) })

let repo: InMemoryChatRepository
let chat: WsChatService
let blocks: InMemoryBlocksRepository
let dmRepo: InMemoryDmRepository
let THREAD: string

const cleanupMember = (cleanupId: string, userId: string): Promise<boolean> =>
  Promise.resolve([ROOM, OTHER_ROOM].includes(cleanupId) && [ALICE, BOB].includes(userId))

function gatewayChat(dedupe?: SendDedupeStore): GatewayDeps["chat"] {
  return {
    joinRoom: (room, conn, userId) => chat.joinRoom(room, conn, userId),
    leaveRoom: (room, conn) => chat.leaveRoom(room, conn),
    persist: (input) => chat.persist(input),
    history: (room, before, limit, viewer, around) =>
      chat.history(room, before, limit, viewer, around),
    broadcast: (room, msg, o) => chat.broadcast(room, msg, o),
    broadcastEvent: (room, frame, o) => chat.broadcastEvent(room, frame, o),
    ...(dedupe
      ? {
          sendResilience: makeSendResilience({
            dedupe,
            findRoomMessage: (kind, roomId, messageId, viewer) =>
              kind === "dm"
                ? dmRepo.findMessage(roomId, messageId, viewer)
                : repo.findMessage(roomId, messageId, viewer),
            sleep: () => Promise.resolve(),
            jitter: () => 0,
          }),
        }
      : {}),
  }
}

function baseDeps(overrides: Partial<GatewayDeps> = {}): GatewayDeps {
  return {
    chat: gatewayChat(),
    isMember: cleanupMember,
    dm: {
      peerOf: (threadId, userId) => Promise.resolve(dmRepo.peerOf(threadId, userId)),
      persist: (input) => dmRepo.persist(input),
      markRead: () => Promise.resolve(),
    },
    isBlockedEitherWay: (a, b) => blocks.isBlockedEitherWay(a, b),
    ...overrides,
  }
}

function sessionFor(
  userId: string,
  conn: MockConnection,
  deps: GatewayDeps = baseDeps(),
  extra: Partial<GatewaySession> = {},
): GatewaySession {
  return {
    userId,
    conn,
    joined: new Set<string>(),
    typingThrottle: new Map<string, number>(),
    deps,
    ...extra,
  }
}

async function cleanupHistory(roomId: string): Promise<ChatMessageDTO[]> {
  return (await repo.history(roomId, undefined, 50, ALICE)).items
}

beforeEach(async () => {
  repo = new InMemoryChatRepository()
  repo.registerSender({ id: ALICE, displayName: "Alice", handle: "alice" })
  repo.registerSender({ id: BOB, displayName: "Bob", handle: "bob" })
  chat = new WsChatService({ repo, pubsub: new InMemoryChatPubSub() })
  blocks = new InMemoryBlocksRepository()
  dmRepo = new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
  dmRepo.registerUser({ id: ALICE, displayName: "Alice", handle: "alice" })
  dmRepo.registerUser({ id: BOB, displayName: "Bob", handle: "bob" })
  THREAD = (await dmRepo.openOrCreateThread(ALICE, BOB)).id
  captured.opts = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("handleSend characterization: room access", () => {
  it("a MEMBER who never joined the room can still send: ack only, no error (send does not require join)", async () => {
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const a = sessionFor(ALICE, aConn)
    const b = sessionFor(BOB, bConn)
    await handleClientFrame(b, join(ROOM))

    await handleClientFrame(a, send({}))
    await flush()

    expect(a.joined.size).toBe(0)
    expect(aConn.frames.map((f) => f.type)).toEqual(["ack"])
    const ack = aConn.frames[0] as { type: string; clientId: string; message: ChatMessageDTO }
    expect(ack.clientId).toBe("c1")
    expect(ack.message).toMatchObject({
      cleanupId: ROOM,
      body: "hello",
      kind: "text",
      mine: true,
      clientId: "c1",
    })
    const delivered = bConn.framesOfType("message") as Array<{ message: ChatMessageDTO }>
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.message.id).toBe(ack.message.id)
    expect(delivered[0]!.message.mine).toBe(false)
    expect(await cleanupHistory(ROOM)).toHaveLength(1)
  })

  it("a NON-member sending to a cleanup room it never joined gets a room-stamped FORBIDDEN and nothing persists", async () => {
    const conn = new MockConnection("M")
    await handleClientFrame(sessionFor(MALLORY, conn), send({}))

    expect(conn.sent).toEqual([
      JSON.stringify({
        type: "error",
        code: "FORBIDDEN",
        message: "You are not a member of this cleanup.",
        cleanupId: ROOM,
      }),
    ])
    expect(await cleanupHistory(ROOM)).toHaveLength(0)
  })

  it("DM send where the peer blocked the sender: FORBIDDEN stamped roomKind dm, nothing persisted", async () => {
    await blocks.block(BOB, ALICE)
    const conn = new MockConnection("A")
    await handleClientFrame(sessionFor(ALICE, conn), send({ cleanupId: THREAD, roomKind: "dm" }))

    expect(conn.sent).toEqual([
      JSON.stringify({
        type: "error",
        code: "FORBIDDEN",
        message: "You can't message in this conversation.",
        cleanupId: THREAD,
        roomKind: "dm",
      }),
    ])
    expect((await dmRepo.history(THREAD, undefined, 50)).items).toHaveLength(0)
  })

  it("DM send where the SENDER blocked the peer is refused with the same frame", async () => {
    await blocks.block(ALICE, BOB)
    const conn = new MockConnection("A")
    await handleClientFrame(sessionFor(ALICE, conn), send({ cleanupId: THREAD, roomKind: "dm" }))

    expect(conn.framesOfType("error")).toEqual([
      {
        type: "error",
        code: "FORBIDDEN",
        message: "You can't message in this conversation.",
        cleanupId: THREAD,
        roomKind: "dm",
      },
    ])
    expect(conn.framesOfType("ack")).toHaveLength(0)
  })

  it("DM send by a non-participant is refused with the same FORBIDDEN text", async () => {
    const conn = new MockConnection("M")
    await handleClientFrame(sessionFor(MALLORY, conn), send({ cleanupId: THREAD, roomKind: "dm" }))

    expect(conn.framesOfType("error")).toEqual([
      {
        type: "error",
        code: "FORBIDDEN",
        message: "You can't message in this conversation.",
        cleanupId: THREAD,
        roomKind: "dm",
      },
    ])
  })

  it("DM send with no dm seam wired: FORBIDDEN 'Direct messages are not available.'", async () => {
    const conn = new MockConnection("A")
    await handleClientFrame(
      sessionFor(ALICE, conn, baseDeps({ dm: undefined })),
      send({ cleanupId: THREAD, roomKind: "dm" }),
    )
    expect(conn.framesOfType("error")).toEqual([
      {
        type: "error",
        code: "FORBIDDEN",
        message: "Direct messages are not available.",
        cleanupId: THREAD,
        roomKind: "dm",
      },
    ])
  })

  it("a successful DM send acks the sender and fires onDmDelivered for the offline peer", async () => {
    const delivered: Array<{ threadId: string; recipientId: string }> = []
    const conn = new MockConnection("A")
    const deps = baseDeps({
      onDmDelivered: (threadId, recipientId) => {
        delivered.push({ threadId, recipientId })
        return Promise.resolve()
      },
    })
    await handleClientFrame(
      sessionFor(ALICE, conn, deps),
      send({ cleanupId: THREAD, roomKind: "dm" }),
    )
    await flush()

    expect(conn.frames.map((f) => f.type)).toEqual(["ack"])
    expect(delivered).toEqual([{ threadId: THREAD, recipientId: BOB }])
  })

  it("report send: invisible report -> NOT_FOUND; visible but not a member -> FORBIDDEN join text; no reportChat seam -> FORBIDDEN unavailable", async () => {
    const conn = new MockConnection("A")
    const reportChat: GatewayReportChat = {
      isMember: () => Promise.resolve(false),
      advanceReadWatermark: () => Promise.resolve(),
    }
    await handleClientFrame(
      sessionFor(
        ALICE,
        conn,
        baseDeps({ reportVisible: () => Promise.resolve(false), reportChat }),
      ),
      send({ cleanupId: REPORT, roomKind: "report" }),
    )
    await handleClientFrame(
      sessionFor(ALICE, conn, baseDeps({ reportVisible: () => Promise.resolve(true), reportChat })),
      send({ cleanupId: REPORT, roomKind: "report" }),
    )
    await handleClientFrame(
      sessionFor(ALICE, conn, baseDeps({ reportVisible: () => Promise.resolve(true) })),
      send({ cleanupId: REPORT, roomKind: "report" }),
    )

    expect(conn.framesOfType("error")).toEqual([
      {
        type: "error",
        code: "NOT_FOUND",
        message: "Report not found.",
        cleanupId: REPORT,
        roomKind: "report",
      },
      {
        type: "error",
        code: "FORBIDDEN",
        message: "Join this report chat to send messages.",
        cleanupId: REPORT,
        roomKind: "report",
      },
      {
        type: "error",
        code: "FORBIDDEN",
        message: "Report chat is not available.",
        cleanupId: REPORT,
        roomKind: "report",
      },
    ])
  })

  it("group send: no seam, null access, non-member of a public group, and a read-only channel member each map to their own error", async () => {
    const conn = new MockConnection("A")
    const groupWith = (
      access: Awaited<ReturnType<GatewayGroupChat["access"]>>,
    ): GatewayGroupChat => ({
      isMember: () => Promise.resolve(false),
      access: () => Promise.resolve(access),
      advanceReadWatermark: () => Promise.resolve(),
    })
    const frame = send({ cleanupId: GROUP, roomKind: "group" })
    await handleClientFrame(sessionFor(ALICE, conn), frame)
    await handleClientFrame(
      sessionFor(ALICE, conn, baseDeps({ groupChat: groupWith(null) })),
      frame,
    )
    await handleClientFrame(
      sessionFor(
        ALICE,
        conn,
        baseDeps({
          groupChat: groupWith({ isMember: false, canPost: false, visibility: "public" }),
        }),
      ),
      frame,
    )
    await handleClientFrame(
      sessionFor(
        ALICE,
        conn,
        baseDeps({
          groupChat: groupWith({ isMember: true, canPost: false, visibility: "private" }),
        }),
      ),
      frame,
    )

    const stamp = { cleanupId: GROUP, roomKind: "group" }
    expect(conn.framesOfType("error")).toEqual([
      { type: "error", code: "FORBIDDEN", message: "Group chat is not available.", ...stamp },
      {
        type: "error",
        code: "FORBIDDEN",
        message: "You are not a member of this group.",
        ...stamp,
      },
      {
        type: "error",
        code: "FORBIDDEN",
        message: "You are not a member of this group.",
        ...stamp,
      },
      {
        type: "error",
        code: "channel_read_only",
        message: "Only owners and admins can post in this channel.",
        ...stamp,
      },
    ])
  })
})

describe("handleSend characterization: frame validation", () => {
  it("kind 'system' from a client is refused as BAD_FRAME (room-stamped) before any auth check", async () => {
    const conn = new MockConnection("M")
    await handleClientFrame(sessionFor(MALLORY, conn), send({ kind: "system" }))

    expect(conn.sent).toEqual([
      JSON.stringify({
        type: "error",
        code: "BAD_FRAME",
        message: "That message kind can't be sent by a client.",
        cleanupId: ROOM,
      }),
    ])
  })

  it("kind 'poll' is refused the same way; the four client kinds are accepted", async () => {
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, send({ kind: "poll", clientId: "p" }))
    for (const kind of ["text", "share_pin", "task_complete", "rsvp_change"]) {
      await handleClientFrame(session, send({ kind, clientId: `k-${kind}` }))
    }

    expect(
      conn.frames.map((f) => (f.type === "error" ? `error:${String(f.message)}` : f.type)),
    ).toEqual(["error:That message kind can't be sent by a client.", "ack", "ack", "ack", "ack"])
  })

  it("a body over MESSAGE_BODY_MAX fails schema validation: unstamped BAD_FRAME, nothing persisted", async () => {
    const conn = new MockConnection("A")
    await handleClientFrame(
      sessionFor(ALICE, conn),
      send({ body: "x".repeat(MESSAGE_BODY_MAX + 1) }),
    )

    expect(conn.sent).toEqual([
      JSON.stringify({
        type: "error",
        code: "BAD_FRAME",
        message: "Frame failed schema validation.",
      }),
    ])
    expect(await cleanupHistory(ROOM)).toHaveLength(0)
  })

  it("a body of exactly MESSAGE_BODY_MAX is accepted", async () => {
    const conn = new MockConnection("A")
    await handleClientFrame(sessionFor(ALICE, conn), send({ body: "x".repeat(MESSAGE_BODY_MAX) }))
    expect(conn.frames.map((f) => f.type)).toEqual(["ack"])
  })

  it("a clientId over 64 chars is caught by the schema (unstamped), so the handler's own clientId check is unreachable over the wire", async () => {
    const conn = new MockConnection("A")
    await handleClientFrame(sessionFor(ALICE, conn), send({ clientId: "c".repeat(65) }))
    expect(conn.sent).toEqual([
      JSON.stringify({
        type: "error",
        code: "BAD_FRAME",
        message: "Frame failed schema validation.",
      }),
    ])
  })

  it("non-JSON is 'Malformed frame: not JSON.'", async () => {
    const conn = new MockConnection("A")
    await handleClientFrame(sessionFor(ALICE, conn), "{nope")
    expect(conn.sent).toEqual([
      JSON.stringify({ type: "error", code: "BAD_FRAME", message: "Malformed frame: not JSON." }),
    ])
  })

  it("a slur is BLOCKED before the membership check (a non-member gets BLOCKED, not FORBIDDEN)", async () => {
    const conn = new MockConnection("M")
    await handleClientFrame(sessionFor(MALLORY, conn), send({ body: "you retard" }))
    expect(conn.sent).toEqual([
      JSON.stringify({
        type: "error",
        code: "BLOCKED",
        message: "This contains language that isn't allowed.",
        cleanupId: ROOM,
      }),
    ])
  })

  it("a whitespace-only text body is 'A message needs text or an attachment.'", async () => {
    const conn = new MockConnection("A")
    await handleClientFrame(sessionFor(ALICE, conn), send({ body: "   " }))
    expect(conn.sent).toEqual([
      JSON.stringify({
        type: "error",
        code: "BAD_FRAME",
        message: "A message needs text or an attachment.",
        cleanupId: ROOM,
      }),
    ])
  })

  it("a whitespace-only body with a non-text kind is accepted and persisted with an empty trimmed body", async () => {
    const conn = new MockConnection("A")
    await handleClientFrame(sessionFor(ALICE, conn), send({ body: "   ", kind: "share_pin" }))
    const ack = conn.framesOfType("ack")[0] as { message: ChatMessageDTO }
    expect(ack.message.kind).toBe("share_pin")
    expect(ack.message.body).toBe("")
  })

  it("the ack carries the TRIMMED body", async () => {
    const conn = new MockConnection("A")
    await handleClientFrame(sessionFor(ALICE, conn), send({ body: "  hi there  " }))
    expect((conn.framesOfType("ack")[0] as { message: ChatMessageDTO }).message.body).toBe(
      "hi there",
    )
  })
})

describe("handleSend characterization: account status", () => {
  it("a suspended session gets the room-stamped suspension FORBIDDEN", async () => {
    const conn = new MockConnection("A")
    await handleClientFrame(
      sessionFor(ALICE, conn, baseDeps(), { accountStatus: "suspended" }),
      send({}),
    )
    expect(conn.sent).toEqual([
      JSON.stringify({
        type: "error",
        code: "FORBIDDEN",
        message: SUSPENDED_TEXT,
        cleanupId: ROOM,
      }),
    ])
  })

  it("a revoked session with closeForAuth closes and emits no frame", async () => {
    const conn = new MockConnection("A")
    const closeForAuth = vi.fn()
    await handleClientFrame(
      sessionFor(ALICE, conn, baseDeps(), {
        revalidateStatus: () => Promise.resolve({ kind: "revoked" }),
        closeForAuth,
      }),
      send({}),
    )
    expect(closeForAuth).toHaveBeenCalledTimes(1)
    expect(conn.sent).toEqual([])
  })

  it("a revoked session without closeForAuth gets UNAUTHORIZED 'Your session ended.'", async () => {
    const conn = new MockConnection("A")
    await handleClientFrame(
      sessionFor(ALICE, conn, baseDeps(), {
        revalidateStatus: () => Promise.resolve({ kind: "revoked" }),
      }),
      send({ cleanupId: THREAD, roomKind: "dm" }),
    )
    expect(conn.sent).toEqual([
      JSON.stringify({
        type: "error",
        code: "UNAUTHORIZED",
        message: "Your session ended.",
        cleanupId: THREAD,
        roomKind: "dm",
      }),
    ])
  })
})

describe("handleSend characterization: rate limits", () => {
  it("the per-connection frame bucket admits 60 frames at one instant; the 61st is an unstamped RATE_LIMITED and is not processed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000)
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    for (let i = 0; i < 60; i++) await handleClientFrame(session, "{}")
    await handleClientFrame(session, send({}))

    const errors = conn.framesOfType("error")
    expect(errors).toHaveLength(61)
    expect(errors.slice(0, 60).every((f) => f.message === "Frame failed schema validation.")).toBe(
      true,
    )
    expect(conn.sent.at(-1)).toBe(
      JSON.stringify({
        type: "error",
        code: "RATE_LIMITED",
        message: "You're sending frames too fast. Please slow down.",
      }),
    )
    expect(await cleanupHistory(ROOM)).toHaveLength(0)
  })

  it("reportSendLimiter is consulted AFTER authorization with key userId:roomKey and applies to every room kind", async () => {
    const keys: string[] = []
    const reportSendLimiter = {
      tryConsume: (key: string) => {
        keys.push(key)
        return false
      },
    }
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn, baseDeps({ reportSendLimiter }))
    await handleClientFrame(session, send({}))
    await handleClientFrame(session, send({ cleanupId: THREAD, roomKind: "dm" }))
    await handleClientFrame(sessionFor(MALLORY, conn, baseDeps({ reportSendLimiter })), send({}))

    expect(keys).toEqual([`${ALICE}:${ROOM}`, `${ALICE}:dm:${THREAD}`])
    expect(conn.framesOfType("error")).toEqual([
      {
        type: "error",
        code: "RATE_LIMITED",
        message: "You're sending messages too fast. Please slow down.",
        cleanupId: ROOM,
      },
      {
        type: "error",
        code: "RATE_LIMITED",
        message: "You're sending messages too fast. Please slow down.",
        cleanupId: THREAD,
        roomKind: "dm",
      },
      {
        type: "error",
        code: "FORBIDDEN",
        message: "You are not a member of this cleanup.",
        cleanupId: ROOM,
      },
    ])
    expect(await cleanupHistory(ROOM)).toHaveLength(0)
  })
})

describe("handleSend characterization: idempotent resend", () => {
  it("a duplicate clientId re-acks the ORIGINAL message: one row, one broadcast, two identical-id acks", async () => {
    const dedupe = new InMemorySendDedupeStore()
    const deps = baseDeps({ chat: gatewayChat(dedupe) })
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const a = sessionFor(ALICE, aConn, deps)
    await handleClientFrame(sessionFor(BOB, bConn, deps), join(ROOM))

    await handleClientFrame(a, send({ clientId: "dup" }))
    await flush()
    await handleClientFrame(a, send({ clientId: "dup", body: "different body" }))
    await flush()

    const acks = aConn.framesOfType("ack") as Array<{ clientId: string; message: ChatMessageDTO }>
    expect(acks).toHaveLength(2)
    expect(acks[1]!.clientId).toBe("dup")
    expect(acks[1]!.message.id).toBe(acks[0]!.message.id)
    expect(acks[1]!.message.body).toBe("hello")
    expect(bConn.framesOfType("message")).toHaveLength(1)
    expect(await cleanupHistory(ROOM)).toHaveLength(1)
  })

  it("the dedupe key is scoped by room: the same clientId in another room is a new message", async () => {
    const dedupe = new InMemorySendDedupeStore()
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn, baseDeps({ chat: gatewayChat(dedupe) }))
    await handleClientFrame(session, send({ clientId: "same" }))
    await handleClientFrame(session, send({ clientId: "same", cleanupId: OTHER_ROOM }))

    const acks = conn.framesOfType("ack") as Array<{ message: ChatMessageDTO }>
    expect(acks).toHaveLength(2)
    expect(acks[0]!.message.id).not.toBe(acks[1]!.message.id)
    expect(sendDedupeKey(ALICE, ROOM, "same")).toBe(`chat:send:${ALICE}:${ROOM}:same`)
  })

  it("a duplicate whose original cannot be re-read falls through and inserts again", async () => {
    const store: SendDedupeStore = {
      reserve: (): Promise<SendReservation> =>
        Promise.resolve({ state: "duplicate", messageId: ROOM }),
      commit: () => Promise.resolve(),
      release: () => Promise.resolve(),
    }
    const conn = new MockConnection("A")
    await handleClientFrame(
      sessionFor(ALICE, conn, baseDeps({ chat: gatewayChat(store) })),
      send({}),
    )
    expect(conn.frames.map((f) => f.type)).toEqual(["ack"])
    expect(await cleanupHistory(ROOM)).toHaveLength(1)
  })

  it("a still-pending reservation ('open') does not block: the resend inserts a second row", async () => {
    const store: SendDedupeStore = {
      reserve: (): Promise<SendReservation> => Promise.resolve({ state: "open" }),
      commit: () => Promise.resolve(),
      release: () => Promise.resolve(),
    }
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn, baseDeps({ chat: gatewayChat(store) }))
    await handleClientFrame(session, send({ clientId: "p" }))
    await handleClientFrame(session, send({ clientId: "p" }))
    expect(await cleanupHistory(ROOM)).toHaveLength(2)
  })
})

describe("handleSend characterization: replies and persist errors", () => {
  it("a reply to a message that lives in ANOTHER cleanup room is reply_wrong_room, no ack, and the reservation is released", async () => {
    const dedupe = new InMemorySendDedupeStore()
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn, baseDeps({ chat: gatewayChat(dedupe) }))
    await handleClientFrame(session, send({ clientId: "orig" }))
    const originalId = (conn.framesOfType("ack")[0] as { message: ChatMessageDTO }).message.id
    conn.sent.length = 0

    await handleClientFrame(
      session,
      send({ cleanupId: OTHER_ROOM, clientId: "r1", replyToId: originalId }),
    )

    expect(conn.sent).toEqual([
      JSON.stringify({
        type: "error",
        code: "reply_wrong_room",
        message: "The message you're replying to isn't in this conversation.",
        cleanupId: OTHER_ROOM,
      }),
    ])
    expect(await cleanupHistory(OTHER_ROOM)).toHaveLength(0)
    await flush()
    expect(await dedupe.reserve(sendDedupeKey(ALICE, OTHER_ROOM, "r1"))).toEqual({
      state: "reserved",
    })
  })

  it("a DM reply to a cleanup message is reply_wrong_room stamped roomKind dm", async () => {
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, send({ clientId: "orig" }))
    const originalId = (conn.framesOfType("ack")[0] as { message: ChatMessageDTO }).message.id
    conn.sent.length = 0

    await handleClientFrame(
      session,
      send({ cleanupId: THREAD, roomKind: "dm", replyToId: originalId }),
    )

    expect(conn.sent).toEqual([
      JSON.stringify({
        type: "error",
        code: "reply_wrong_room",
        message: "The message you're replying to isn't in this conversation.",
        cleanupId: THREAD,
        roomKind: "dm",
      }),
    ])
  })

  it("an AppError without a fields.code surfaces its ErrorCode and message", async () => {
    const conn = new MockConnection("A")
    const deps = baseDeps()
    deps.chat = { ...deps.chat, persist: () => Promise.reject(AppError.forbidden("nope")) }
    await handleClientFrame(sessionFor(ALICE, conn, deps), send({}))
    expect(conn.framesOfType("error")).toEqual([
      { type: "error", code: "FORBIDDEN", message: "nope", cleanupId: ROOM },
    ])
  })

  it("a non-AppError from persist is rethrown out of handleClientFrame with no frame sent", async () => {
    const conn = new MockConnection("A")
    const deps = baseDeps()
    deps.chat = { ...deps.chat, persist: () => Promise.reject(new Error("db down")) }
    await expect(handleClientFrame(sessionFor(ALICE, conn, deps), send({}))).rejects.toThrow(
      "db down",
    )
    expect(conn.sent).toEqual([])
  })
})

describe("wireChatGateway characterization", () => {
  function fakeContainer(extra: Record<string, unknown> = {}): Container {
    return {
      env: { USE_FAKE_CHAT: true, USE_FAKE_JOBS: true, WEB_ORIGINS: ["https://civfix.test"] },
      storage: { presignGet: () => Promise.resolve("") },
      chatService: chat,
      userChannel: { marker: "user-channel" },
      ...extra,
    } as unknown as Container
  }

  function appWith(
    overrides: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): FastifyInstance {
    return {
      chatOverrides: {
        isMember: cleanupMember,
        threadsRepo: new InMemoryThreadsRepository(),
        dmRepo,
        blocksRepo: blocks,
        chatRepo: repo,
        ...overrides,
      },
      log: { warn: () => {}, error: () => {} },
      ...extra,
    } as unknown as FastifyInstance
  }

  function wiredDeps(opts: RegisterGatewayOptions): GatewayDeps {
    return {
      chat: opts.chat,
      isMember: opts.isMember,
      presence: opts.presence,
      dm: opts.dm,
      isBlockedEitherWay: opts.isBlockedEitherWay,
      reportSendLimiter: opts.reportSendLimiter,
    }
  }

  it("fake chat + minimal overrides: which seams are wired and which are left undefined", async () => {
    const container = fakeContainer()
    const app = appWith({})
    const wiring = wireChatGateway(app, container)
    const opts = captured.opts!

    expect(opts.isMember).toBe(cleanupMember)
    expect(opts.sessions).toBeUndefined()
    expect("redeemTicket" in opts).toBe(false)
    expect(opts.presence).toBeInstanceOf(InMemoryChatPresence)
    expect(Object.keys(opts.dm!).sort()).toEqual(["markRead", "peerOf", "persist"])
    expect(opts.userChannel).toBe(container.userChannel)
    expect(opts.webOrigins).toEqual(["https://civfix.test"])
    expect(typeof opts.markRead).toBe("function")
    expect(typeof opts.markReadOnOpen).toBe("function")
    expect(typeof opts.threadRecipientsOf).toBe("function")
    expect(opts.reportSendLimiter).toBeDefined()
    expect(opts.onDmDelivered).toBeUndefined()
    expect(opts.chatMentions).toBeUndefined()
    expect(opts.onReportMessage).toBeUndefined()
    expect(opts.onGroupMessage).toBeUndefined()
    expect(opts.onChatReply).toBeUndefined()
    expect(opts.reportVisible).toBeUndefined()
    expect(opts.reportChat).toBeUndefined()
    expect(opts.groupChat).toBeUndefined()
    const wiredChat = opts.chat as GatewayDeps["chat"]
    expect(Object.keys(wiredChat).sort()).toEqual([
      "broadcast",
      "broadcastEvent",
      "history",
      "joinRoom",
      "leaveRoom",
      "persist",
      "sendResilience",
    ])

    expect(wiring.readState).toBeInstanceOf(InMemoryChatReadState)
    expect(wiring.isMember).toBe(cleanupMember)
    expect(wiring.dmRepo).toBe(dmRepo)
    expect(await wiring.isBlockedEitherWay(ALICE, BOB)).toBe(false)
    await blocks.block(BOB, ALICE)
    expect(await wiring.isBlockedEitherWay(ALICE, BOB)).toBe(true)
    expect(Object.keys(wiring).sort()).toEqual([
      "dmPeerOf",
      "dmRepo",
      "getChatRepo",
      "isBlockedEitherWay",
      "isMember",
      "listDmThreadsFor",
      "readState",
    ])
    expect(wiring.getChatRepo()).toBe(repo)
  })

  it("the wired chat omits broadcastEvent when the container chat service has none", () => {
    const bare = {
      joinRoom: () => Promise.resolve(),
      leaveRoom: () => Promise.resolve(),
      persist: () => Promise.reject(new Error("unused")),
      history: () => Promise.resolve({ items: [], nextCursor: null }),
      broadcast: () => Promise.resolve(),
    }
    wireChatGateway(appWith({}), fakeContainer({ chatService: bare }))
    expect("broadcastEvent" in (captured.opts!.chat as object)).toBe(false)
  })

  it("fake chat + full overrides: overrides are passed through or wrapped; bells that need real chat stay off", () => {
    const presence = new InMemoryChatPresence()
    const reportVisible = () => Promise.resolve(true)
    const chatMentions = {
      resolveChatMentions: () => Promise.resolve([]),
      recordChatMentions: () => Promise.resolve(),
      notifyChatMention: () => Promise.resolve(),
    }
    const reportChat = { isMember: () => Promise.resolve(true) } as unknown as ReportChatRepository
    const groups = {
      roleOf: () => Promise.resolve("member"),
      accessOf: () => Promise.resolve({ kind: "channel", visibility: "public", role: "member" }),
    } as unknown as ChatGroupRepository
    const notificationService = {} as unknown as NotificationService
    const conversationMutes = {
      isMuted: () => Promise.resolve(false),
    } as unknown as ConversationMutesRepository

    wireChatGateway(
      appWith({
        presence,
        reportVisible,
        chatMentions,
        reportChat,
        groups,
        notificationService,
        conversationMutes,
      }),
      fakeContainer(),
    )
    const opts = captured.opts!

    expect(opts.presence).toBe(presence)
    expect(opts.reportVisible).toBe(reportVisible)
    expect(opts.chatMentions).toBe(chatMentions)
    expect(opts.reportChat).toBeDefined()
    expect(opts.reportChat).not.toBe(reportChat)
    expect(opts.groupChat).toBeDefined()
    expect(typeof opts.onDmDelivered).toBe("function")
    expect(typeof opts.onGroupMessage).toBe("function")
    expect(opts.onChatReply).toBeUndefined()
    expect(opts.onReportMessage).toBeUndefined()
  })

  it("groupChat.access maps repo access through canPostToGroup (channel member: member, cannot post)", async () => {
    const groups = {
      roleOf: (_g: string, userId: string) => Promise.resolve(userId === ALICE ? "member" : null),
      accessOf: (_g: string, userId: string) =>
        Promise.resolve(
          userId === ALICE
            ? { kind: "channel", visibility: "public", role: "member" }
            : userId === BOB
              ? { kind: "group", visibility: "private", role: null }
              : null,
        ),
    } as unknown as ChatGroupRepository
    wireChatGateway(appWith({ groups }), fakeContainer())
    const groupChat = captured.opts!.groupChat!

    expect(await groupChat.access(GROUP, ALICE)).toEqual({
      isMember: true,
      canPost: false,
      visibility: "public",
    })
    expect(await groupChat.access(GROUP, BOB)).toEqual({
      isMember: false,
      canPost: false,
      visibility: "private",
    })
    expect(await groupChat.access(GROUP, MALLORY)).toBeNull()
    expect(await groupChat.isMember(GROUP, ALICE)).toBe(true)
    expect(await groupChat.isMember(GROUP, BOB)).toBe(false)
  })

  it("authServices wires sessions and a ticket redeemer only when a cache exists", () => {
    const sessions = { marker: "sessions" }
    wireChatGateway(appWith({}, { authServices: { sessions } }), fakeContainer())
    expect(captured.opts!.sessions).toBe(sessions)
    expect("redeemTicket" in captured.opts!).toBe(false)

    wireChatGateway(appWith({}, { authServices: { sessions, cache: {} } }), fakeContainer())
    expect(typeof captured.opts!.redeemTicket).toBe("function")
  })

  it("registers the /ws upgrade limiter (60 per minute keyed by wsUpgradeRateLimitKey) only when createRateLimit exists", () => {
    const createRateLimit = vi.fn(
      () => () => Promise.resolve({ isAllowed: true, isExceeded: false }),
    )
    const addHook = vi.fn()
    wireChatGateway(appWith({}, { createRateLimit, addHook }), fakeContainer())
    expect(createRateLimit).toHaveBeenCalledWith({
      max: 60,
      timeWindow: "1 minute",
      keyGenerator: wsUpgradeRateLimitKey,
    })
    expect(addHook).toHaveBeenCalledTimes(1)
    expect(addHook.mock.calls[0]![0]).toBe("onRequest")

    const addHookOnly = vi.fn()
    wireChatGateway(appWith({}, { addHook: addHookOnly }), fakeContainer())
    expect(addHookOnly).not.toHaveBeenCalled()
  })

  it("the wired send limiter is a 30-token bucket per userId:roomKey", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000_000)
    wireChatGateway(appWith({}), fakeContainer())
    const limiter = captured.opts!.reportSendLimiter!
    const results = Array.from({ length: 31 }, () => limiter.tryConsume(`${ALICE}:${ROOM}`))
    expect(results.slice(0, 30).every(Boolean)).toBe(true)
    expect(results[30]).toBe(false)
    expect(limiter.tryConsume(`${BOB}:${ROOM}`)).toBe(true)
  })

  it("threadRecipientsOf under fake chat: dm -> the peer, report -> none, cleanup -> none, group without repo -> none", async () => {
    wireChatGateway(appWith({}), fakeContainer())
    const recipientsOf = captured.opts!.threadRecipientsOf!
    expect(await recipientsOf("dm", THREAD, ALICE)).toEqual([BOB])
    expect(await recipientsOf("dm", THREAD, MALLORY)).toEqual([])
    expect(await recipientsOf("report", REPORT, ALICE)).toEqual([])
    expect(await recipientsOf("cleanup", ROOM, ALICE)).toEqual([])
    expect(await recipientsOf("group", GROUP, ALICE)).toEqual([])
  })

  it("under fake chat, cleanup markRead stamps the read state with 'now' regardless of upToId", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 5, 1) })
    const wiring = wireChatGateway(appWith({}), fakeContainer())
    await captured.opts!.markRead!(ROOM, ALICE, "ffffffff-ffff-ffff-ffff-ffffffffffff")
    expect(await wiring.readState.lastReadAt(ROOM, ALICE)).toEqual(new Date(Date.UTC(2026, 5, 1)))
  })

  it("end to end through the wiring: a resent clientId re-acks the original via the in-memory dedupe store", async () => {
    wireChatGateway(appWith({}), fakeContainer())
    const deps = wiredDeps(captured.opts!)
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn, deps)

    await handleClientFrame(session, send({ clientId: "w1" }))
    await flush()
    await handleClientFrame(session, send({ clientId: "w1" }))
    await flush()

    const acks = conn.framesOfType("ack") as Array<{ message: ChatMessageDTO }>
    expect(acks).toHaveLength(2)
    expect(acks[1]!.message.id).toBe(acks[0]!.message.id)
    expect(await cleanupHistory(ROOM)).toHaveLength(1)
  })

  it("end to end through the wiring: a blocked DM peer is refused with FORBIDDEN", async () => {
    await blocks.block(BOB, ALICE)
    wireChatGateway(appWith({}), fakeContainer())
    const conn = new MockConnection("A")
    await handleClientFrame(
      sessionFor(ALICE, conn, wiredDeps(captured.opts!)),
      send({ cleanupId: THREAD, roomKind: "dm" }),
    )
    expect(conn.sent).toEqual([
      JSON.stringify({
        type: "error",
        code: "FORBIDDEN",
        message: "You can't message in this conversation.",
        cleanupId: THREAD,
        roomKind: "dm",
      }),
    ])
  })
})
