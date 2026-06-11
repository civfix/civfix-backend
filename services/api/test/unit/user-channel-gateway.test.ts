import { describe, it, expect, beforeEach } from "vitest"
import { FakeUserChannel } from "@civfix/shared/fakes"
import { WsServerMessageSchema, UserSignalSchema } from "@civfix/shared"
import {
  handleClientFrame,
  registerChatGateway,
  subscribeUserChannel,
  type GatewayDeps,
  type GatewaySession,
  type ThreadRecipientsOf,
} from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatPresence } from "../../src/adapters/chat-presence.js"
import { InMemoryChatRepository, MockConnection } from "../helpers/chat.js"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { WebSocket } from "@fastify/websocket"

/**
 * The per-user signal channel woven into the WS gateway, exercised offline with the FakeUserChannel:
 *   - subscribe-on-connect: an authenticated socket subscribes its user once (subscriberCount === 1);
 *     disposing the returned unsubscribe drops it (=== 0);
 *   - per-user isolation: a publishToUser(userA) delivers a {type:"signal"} frame to userA's conn only;
 *   - multi-device: two conns for the SAME user both receive the signal, and closing one keeps the other;
 *   - resilience: a userChannel whose subscribeUser REJECTS does not crash the handshake (returns no
 *     disposer, swallows the error);
 *   - send fan-out: a `send` fires a {topic:"threads", id} signal to the resolver's recipients (which
 *     already EXCLUDE the sender), and a throwing resolver / publish never fails the send path.
 * Every delivered signal frame validates against the shared server schema.
 */

const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"
const CAROL = "33333333-3333-3333-3333-333333333333"

let channel: FakeUserChannel
let chat: WsChatService
let pubsub: InMemoryChatPubSub
let repo: InMemoryChatRepository
let presence: InMemoryChatPresence

/** Members of ROOM: Alice + Bob + Carol. */
function memberOf(cleanupId: string, userId: string): Promise<boolean> {
  const members = new Set([ALICE, BOB, CAROL])
  return Promise.resolve(cleanupId === ROOM && members.has(userId))
}

beforeEach(() => {
  channel = new FakeUserChannel()
  pubsub = new InMemoryChatPubSub()
  repo = new InMemoryChatRepository()
  presence = new InMemoryChatPresence()
  repo.registerSender({ id: ALICE, displayName: "Alice" })
  repo.registerSender({ id: BOB, displayName: "Bob" })
  chat = new WsChatService({ repo, pubsub })
})

/** Assert a raw frame string parses as a valid server frame. */
function assertServerFrame(raw: string): void {
  const parsed = WsServerMessageSchema.safeParse(JSON.parse(raw))
  expect(parsed.success, `frame failed server schema: ${raw}`).toBe(true)
}

describe("subscribeUserChannel (per-socket lifecycle)", () => {
  it("subscribes the user once and disposing unsubscribes", async () => {
    const conn = new MockConnection("A")
    const dispose = await subscribeUserChannel(channel, ALICE, conn)
    expect(channel.subscriberCount(ALICE)).toBe(1)
    expect(dispose).toBeDefined()

    await dispose!()
    expect(channel.subscriberCount(ALICE)).toBe(0)
  })

  it("no channel wired -> no-op (returns undefined, nothing to dispose)", async () => {
    const conn = new MockConnection("A")
    const dispose = await subscribeUserChannel(undefined, ALICE, conn)
    expect(dispose).toBeUndefined()
  })

  it("delivers a publishToUser signal to that user's conn ONLY (per-user isolation)", async () => {
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    await subscribeUserChannel(channel, ALICE, aConn)
    await subscribeUserChannel(channel, BOB, bConn)

    await channel.publishToUser(ALICE, { topic: "notifications" })

    const aSignals = aConn.framesOfType("signal")
    expect(aSignals).toHaveLength(1)
    expect(aSignals[0]).toMatchObject({ type: "signal", topic: "notifications" })
    // Bob (a different user) received nothing.
    expect(bConn.framesOfType("signal")).toHaveLength(0)
    for (const raw of aConn.sent) assertServerFrame(raw)
  })

  it("multi-device: two conns for the same user both receive it; closing one keeps the other", async () => {
    const a1 = new MockConnection("A1")
    const a2 = new MockConnection("A2")
    const dispose1 = await subscribeUserChannel(channel, ALICE, a1)
    await subscribeUserChannel(channel, ALICE, a2)
    expect(channel.subscriberCount(ALICE)).toBe(2)

    await channel.publishToUser(ALICE, { topic: "threads", id: ROOM })
    expect(a1.framesOfType("signal")).toHaveLength(1)
    expect(a2.framesOfType("signal")).toHaveLength(1)
    expect(a1.framesOfType("signal")[0]).toMatchObject({ type: "signal", topic: "threads", id: ROOM })

    // Close the first device; the second still gets later signals.
    await dispose1!()
    expect(channel.subscriberCount(ALICE)).toBe(1)
    await channel.publishToUser(ALICE, { topic: "notifications" })
    expect(a1.framesOfType("signal")).toHaveLength(1) // unchanged
    expect(a2.framesOfType("signal")).toHaveLength(2)
  })

  it("a subscribeUser that REJECTS does not crash the handshake (returns undefined)", async () => {
    const rejecting = new FakeUserChannel()
    rejecting.subscribeUser = () => Promise.reject(new Error("redis down"))
    const conn = new MockConnection("A")
    // No throw: the helper swallows it and returns no disposer, so the socket still serves chat.
    const dispose = await subscribeUserChannel(rejecting, ALICE, conn)
    expect(dispose).toBeUndefined()
  })
})

describe("send fires a {topic:'threads'} signal to recipients (sender excluded by the resolver)", () => {
  /** Build a gateway session wired with the user channel + a recipients resolver. */
  function sessionFor(
    userId: string,
    conn: MockConnection,
    threadRecipientsOf: ThreadRecipientsOf,
  ): GatewaySession {
    const deps: GatewayDeps = {
      chat,
      isMember: memberOf,
      presence,
      userChannel: channel,
      threadRecipientsOf,
    }
    return { userId, conn, joined: new Set<string>(), typingThrottle: new Map<string, number>(), deps }
  }

  it("publishes a threads signal to the resolved recipients on a cleanup send", async () => {
    // Resolver returns the room's OTHER members (Bob, Carol) — the sender (Alice) is already excluded.
    const recipients: ThreadRecipientsOf = (_kind, _id, senderId) =>
      Promise.resolve([BOB, CAROL].filter((m) => m !== senderId))
    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn, recipients)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c1", body: "hello room" }),
    )
    // Let the fire-and-forget signal IIFE settle.
    await flush()

    // One threads signal per recipient, NONE to the sender, all carrying the room id.
    const published = channel.published
    expect(published).toHaveLength(2)
    expect(published.map((p) => p.userId).sort()).toEqual([BOB, CAROL].sort())
    expect(published.every((p) => p.signal.topic === "threads" && p.signal.id === ROOM)).toBe(true)
    expect(published.some((p) => p.userId === ALICE)).toBe(false)
    // The signal payload is contract-valid.
    for (const p of published) expect(UserSignalSchema.safeParse(p.signal).success).toBe(true)
  })

  it("an EMPTY recipient set publishes nothing", async () => {
    const noRecipients: ThreadRecipientsOf = () => Promise.resolve([])
    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn, noRecipients)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c1", body: "alone" }),
    )
    await flush()
    expect(channel.published).toHaveLength(0)
    // The send itself still succeeded (Alice was acked).
    expect(aConn.framesOfType("ack")).toHaveLength(1)
  })

  it("a THROWING resolver does not fail the send (the sender is still acked, message persisted)", async () => {
    const throwing: ThreadRecipientsOf = () => Promise.reject(new Error("resolver boom"))
    const aConn = new MockConnection("A")
    const aSession = sessionFor(ALICE, aConn, throwing)
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c1", body: "still works" }),
    )
    await flush()
    // No signal published, but the send path is intact: ack delivered + message persisted.
    expect(channel.published).toHaveLength(0)
    expect(aConn.framesOfType("ack")).toHaveLength(1)
    expect(repo.count(ROOM)).toBe(1)
  })

  it("a THROWING publishToUsers does not fail the send", async () => {
    const recipients: ThreadRecipientsOf = () => Promise.resolve([BOB])
    const throwingChannel = new FakeUserChannel()
    throwingChannel.publishToUsers = () => Promise.reject(new Error("publish boom"))
    const aConn = new MockConnection("A")
    const deps: GatewayDeps = {
      chat,
      isMember: memberOf,
      presence,
      userChannel: throwingChannel,
      threadRecipientsOf: recipients,
    }
    const aSession: GatewaySession = {
      userId: ALICE,
      conn: aConn,
      joined: new Set<string>(),
      typingThrottle: new Map<string, number>(),
      deps,
    }
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c1", body: "publish fails" }),
    )
    await flush()
    expect(aConn.framesOfType("ack")).toHaveLength(1)
    expect(repo.count(ROOM)).toBe(1)
  })

  it("no userChannel / no resolver wired -> send works with no signal", async () => {
    const aConn = new MockConnection("A")
    const deps: GatewayDeps = { chat, isMember: memberOf, presence } // neither userChannel nor resolver
    const aSession: GatewaySession = {
      userId: ALICE,
      conn: aConn,
      joined: new Set<string>(),
      typingThrottle: new Map<string, number>(),
      deps,
    }
    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(
      aSession,
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c1", body: "no signals here" }),
    )
    await flush()
    expect(channel.published).toHaveLength(0)
    expect(aConn.framesOfType("ack")).toHaveLength(1)
  })
})

/**
 * The Fastify-adapter wiring in registerChatGateway, exercised through the REAL handler with a mock socket
 * (no network / no `ws` client — the handler only needs readyState + send/close/terminate/ping + on()).
 * Covers the subscribe-on-handshake / unsubscribe-on-close lifecycle AND the close-during-subscribe race:
 *   - a normal OPEN handshake subscribes the user (subscriberCount === 1); the "close" event disposes it (=== 0);
 *   - if the socket is NON-OPEN while subscribeUser is still pending, the handshake's close-during-subscribe
 *     guard must dispose the subscription so it never leaks — subscriberCount === 0 after the handshake settles,
 *     even though the lost "close" event never reached a (not-yet-registered) listener.
 */
describe("registerChatGateway (subscribe-on-handshake / unsubscribe-on-close wiring + race)", () => {
  /** ws readyState constants used by the gateway's OPEN check. */
  const WS_OPEN = 1
  const WS_CLOSED = 3

  /**
   * A minimal mock of the raw ws WebSocket the gateway handler drives. Records listeners so a test can fire
   * "close" deterministically, and exposes a mutable readyState so a test can simulate a socket that closed
   * mid-handshake. No real I/O.
   */
  class MockSocket {
    readyState = WS_OPEN
    readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    on(event: string, cb: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? []
      list.push(cb)
      this.listeners.set(event, list)
      return this
    }
    /** Fire every listener registered for an event (e.g. the gateway's "close" cleanup). */
    emit(event: string): void {
      for (const cb of this.listeners.get(event) ?? []) cb()
    }
    send(): void {}
    close(): void {}
    terminate(): void {}
    ping(): void {}
  }

  /** A request that resolves to an authenticated user with no cookie/Origin (webOrigins:[] allows all). */
  function authedRequest(userId: string): FastifyRequest {
    return {
      auth: { userId },
      headers: {},
      cookies: {},
      query: {},
      log: { warn() {}, error() {}, info() {} },
    } as unknown as FastifyRequest
  }

  /**
   * A mock FastifyInstance whose `app.get("/ws", opts, handler)` captures the gateway handler so a test can
   * invoke it directly with a mock socket. registerChatGateway calls only app.get.
   */
  function captureGatewayHandler(opts: Parameters<typeof registerChatGateway>[1]): (
    socket: WebSocket,
    request: FastifyRequest,
  ) => void {
    let captured: ((socket: WebSocket, request: FastifyRequest) => void) | undefined
    const app = {
      get(
        _path: string,
        _opts: unknown,
        handler: (socket: WebSocket, request: FastifyRequest) => void,
      ): void {
        captured = handler
      },
    } as unknown as FastifyInstance
    registerChatGateway(app, opts)
    if (!captured) throw new Error("gateway handler was not registered")
    return captured
  }

  /** Base options: real WsChatService + member probe + the FakeUserChannel + an all-origins allowlist. */
  function baseOpts(userChannel: FakeUserChannel): Parameters<typeof registerChatGateway>[1] {
    return {
      chat,
      isMember: memberOf,
      sessions: undefined,
      userChannel,
      webOrigins: [],
    }
  }

  it("an OPEN handshake subscribes the user; the close event disposes the subscription", async () => {
    const handler = captureGatewayHandler(baseOpts(channel))
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, authedRequest(ALICE))
    // The handler's body is an async IIFE (handshake + subscribe are awaited); let it settle.
    await flush()

    expect(channel.subscriberCount(ALICE)).toBe(1)
    // The gateway registered a "close" listener; firing it must unsubscribe the user.
    socket.emit("close")
    await flush()
    expect(channel.subscriberCount(ALICE)).toBe(0)
  })

  it("close DURING subscribe (socket non-OPEN while subscribeUser pending) does not leak the subscription", async () => {
    // A channel whose subscribeUser stays pending until we resolve it; meanwhile the socket "closes".
    const racingChannel = new FakeUserChannel()
    let releaseSubscribe: (() => void) | undefined
    const realSubscribe = racingChannel.subscribeUser.bind(racingChannel)
    racingChannel.subscribeUser = (userId, conn) =>
      new Promise((resolve) => {
        releaseSubscribe = () => resolve(realSubscribe(userId, conn))
      })

    const handler = captureGatewayHandler(baseOpts(racingChannel))
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, authedRequest(ALICE))
    await flush()

    // The subscribe is still pending — and the socket closes before the handshake installs its "close"
    // listener (the listener never sees this close). Mark the socket CLOSED, then let subscribe complete.
    socket.readyState = WS_CLOSED
    releaseSubscribe!()
    await flush()
    await flush()

    // The close-during-subscribe guard must have disposed the subscription: no leak, and no "close"
    // listener was ever registered to catch the lost close (firing it is a no-op).
    expect(racingChannel.subscriberCount(ALICE)).toBe(0)
    socket.emit("close")
    await flush()
    expect(racingChannel.subscriberCount(ALICE)).toBe(0)
  })
})

/** Let the microtask queue (the fire-and-forget signal IIFE) drain before asserting. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}
