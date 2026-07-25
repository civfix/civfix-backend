import { describe, it, expect, beforeEach, vi } from "vitest"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { WebSocket } from "@fastify/websocket"
import { FakeUserChannel } from "@civfix/shared/fakes"
import {
  MAX_CONNECTIONS_PER_IP,
  MAX_CONNECTIONS_PER_USER,
  registerChatGateway,
  wrapSocket,
  WS_BUFFER_DROP_THRESHOLD,
  WS_BUFFER_TERMINATE_TICKS,
  WS_HANDSHAKE_BUFFER_BYTES,
  WS_HANDSHAKE_FRAME_BUFFER,
  WS_HEARTBEAT_MS,
} from "../../src/ws/gateway.js"
import type { RateLimiter } from "../../src/ws/report-rate-limit.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatPresence } from "../../src/adapters/chat-presence.js"
import { InMemoryChatRepository } from "../helpers/chat.js"

/**
 * The socket LIFECYCLE half of the gateway (ws/socket-lifecycle.ts), driven through the real Fastify
 * handler with a mock socket — no network, no `ws` client. Covers the parts that only exist between
 * "upgrade accepted" and "session established", which no other suite touches:
 *
 *   - HANDSHAKE FRAME BUFFER: a client sends `join` the instant the socket opens (the gateway emits no
 *     ready signal) while the handshake is still awaiting its auth store. Those frames must be buffered
 *     and drained, not dropped — and a REJECTED handshake must discard them unread.
 *   - CONNECTION CAPS: the per-user AND per-IP ceilings reject the (cap+1)-th socket, and a slot is
 *     released EXACTLY ONCE per socket (a double "close" must not hand out a free slot), including on the
 *     close-during-subscribe path where the handshake bails before the session exists. Both caps come
 *     from the exported constants, so a test can't keep passing against a number that has since moved.
 *   - BACKPRESSURE: wrapSocket drops only droppable frame types once the outbound buffer is over
 *     threshold, and the heartbeat terminates a socket that stays over threshold for
 *     WS_BUFFER_TERMINATE_TICKS ticks even while it answers pings. All THREE heartbeat outcomes are
 *     pinned separately — survive (responsive + drained), backpressure-terminate, missed-pong-terminate —
 *     so a backpressure "terminate" can't be a missed-pong terminate wearing its name.
 *   - SEND-LIMITER ROUTING: makeSendLimiter sends report keys to the injected report bucket and
 *     cleanup/dm keys to their own, so one room kind can never spend another's budget.
 */

const WS_OPEN = 1
const WS_CLOSED = 3

const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ALICE = "11111111-1111-1111-1111-111111111111"

/** A distinct uuid per index, for the per-IP cap test (many users sharing one address). */
function userN(n: number): string {
  return `2222${String(n).padStart(4, "0")}-2222-2222-2222-222222222222`
}

/** A distinct address per index, so the per-USER cap is exercised without the per-IP cap interfering. */
function ipN(n: number): string {
  return `198.51.100.${n + 1}`
}

let chat: WsChatService
let repo: InMemoryChatRepository
let presence: InMemoryChatPresence

beforeEach(() => {
  repo = new InMemoryChatRepository()
  repo.registerSender({ id: ALICE, displayName: "Alice" })
  presence = new InMemoryChatPresence()
  chat = new WsChatService({ repo, pubsub: new InMemoryChatPubSub() })
})

/**
 * A minimal stand-in for the raw `ws` socket the gateway drives: records outbound frames, closes,
 * terminates and pings, and lets a test fire listeners ("message", "close") deterministically.
 * `respondToPing` models a client that answers the heartbeat — needed to reach the buffer-terminate
 * path, which is otherwise pre-empted by the missed-pong terminate.
 */
class MockSocket {
  readyState = WS_OPEN
  bufferedAmount = 0
  respondToPing = true
  terminated = 0
  pings = 0
  readonly sent: string[] = []
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = []
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  on(event: string, cb: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(cb)
    this.listeners.set(event, list)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    this.readyState = WS_CLOSED
  }

  terminate(): void {
    this.terminated += 1
    this.readyState = WS_CLOSED
  }

  ping(): void {
    this.pings += 1
    if (this.respondToPing) this.emit("pong")
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }

  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.frames().filter((f) => f.type === type)
  }
}

/** ROOM's only member is Alice. */
function memberOf(cleanupId: string, userId: string): Promise<boolean> {
  return Promise.resolve(cleanupId === ROOM && userId === ALICE)
}

/** An upgrade the auth hook already resolved (no cookie, no Origin — webOrigins:[] allows all). */
function authedRequest(userId: string, ip = "203.0.113.7"): FastifyRequest {
  return {
    auth: { userId },
    ip,
    headers: {},
    cookies: {},
    query: {},
    log: { warn() {}, error() {}, info() {}, debug() {} },
  } as unknown as FastifyRequest
}

/** An upgrade carrying no credential at all: the handshake must reject it. */
function anonRequest(ip = "203.0.113.8"): FastifyRequest {
  return {
    ip,
    headers: {},
    cookies: {},
    query: {},
    log: { warn() {}, error() {}, info() {}, debug() {} },
  } as unknown as FastifyRequest
}

type GatewayOptions = Parameters<typeof registerChatGateway>[1]

/** Capture the /ws handler registered by the gateway so a test can drive it with a mock socket. */
function captureGatewayHandler(
  opts: GatewayOptions,
): (socket: WebSocket, request: FastifyRequest) => void {
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

function baseOpts(extra: Partial<GatewayOptions> = {}): GatewayOptions {
  return {
    chat,
    isMember: memberOf,
    sessions: undefined,
    presence,
    webOrigins: [],
    ...extra,
  }
}

/** Drain the microtask queue AND the macrotask turn (real timers). */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

/** Microtask-only drain, for the fake-timer tests where setTimeout never fires on its own. */
async function microflush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

describe("frames sent during the async handshake are buffered, not dropped", () => {
  it("a join sent before the handshake settles is applied once the session exists", async () => {
    const handler = captureGatewayHandler(baseOpts())
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, authedRequest(ALICE))
    // SYNCHRONOUSLY, i.e. strictly before the handshake IIFE's first await settles: the client's first
    // frame. Without the pre-attached buffering listener `ws` would drop it on the floor.
    socket.emit("message", JSON.stringify({ type: "join", cleanupId: ROOM }))
    await flush()

    expect(socket.framesOfType("presence_snapshot")).toHaveLength(1)
    expect(chat.roomSize(ROOM)).toBe(1)
  })

  it("buffered frames are drained IN ORDER (a join lands before the send that followed it)", async () => {
    const handler = captureGatewayHandler(baseOpts())
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, authedRequest(ALICE))
    socket.emit("message", JSON.stringify({ type: "join", cleanupId: ROOM }))
    socket.emit(
      "message",
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c1", body: "hello" }),
    )
    await flush()

    const types = socket.frames().map((f) => f.type)
    expect(types.indexOf("presence_snapshot")).toBeGreaterThanOrEqual(0)
    expect(types.indexOf("ack")).toBeGreaterThan(types.indexOf("presence_snapshot"))
    expect(repo.count(ROOM)).toBe(1)
  })

  it("a REJECTED handshake discards the buffer unread (only the error frame goes out)", async () => {
    const handler = captureGatewayHandler(baseOpts())
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, anonRequest())
    socket.emit("message", JSON.stringify({ type: "join", cleanupId: ROOM }))
    await flush()

    expect(socket.framesOfType("error")).toHaveLength(1)
    expect(socket.framesOfType("error")[0]).toMatchObject({ code: "UNAUTHORIZED" })
    expect(socket.framesOfType("presence_snapshot")).toHaveLength(0)
    expect(chat.roomSize(ROOM)).toBe(0)
  })

  /**
   * The pre-authentication buffer is bounded TWICE over: by frame COUNT and by total BYTES. The byte
   * ceiling is the one that matters for an abusive socket — fastifyWebsocket allows a 64 KiB payload, so a
   * count-only bound let an UNAUTHENTICATED socket park ~2 MB (32 x 64 KiB) in the process for the whole
   * handshake, and the per-user/per-IP connection caps are only applied after the handshake resolves.
   *
   * Both cases are observed the same way: fill the buffer to its bound with junk, then send a legitimate
   * `join` and assert it never took effect — the bound dropped it.
   */
  it("stops buffering past the BYTE ceiling (a legit join behind 64 KiB of junk is dropped)", async () => {
    const handler = captureGatewayHandler(baseOpts())
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, authedRequest(ALICE))
    // Two 32 KiB frames exactly fill WS_HANDSHAKE_BUFFER_BYTES while staying far under the frame COUNT
    // bound, so only the byte accounting can be what rejects the join below.
    const filler = JSON.stringify("x".repeat(WS_HANDSHAKE_BUFFER_BYTES / 2 - 2))
    expect(Buffer.byteLength(filler)).toBe(WS_HANDSHAKE_BUFFER_BYTES / 2)
    socket.emit("message", filler)
    socket.emit("message", filler)
    socket.emit("message", JSON.stringify({ type: "join", cleanupId: ROOM }))
    await flush()

    expect(socket.framesOfType("presence_snapshot")).toHaveLength(0)
    expect(chat.roomSize(ROOM)).toBe(0)
  })

  it("still stops buffering past the frame COUNT, independently of size", async () => {
    const handler = captureGatewayHandler(baseOpts())
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, authedRequest(ALICE))
    // Tiny frames: the byte ceiling is nowhere near reached, so the count bound is what drops the join.
    for (let i = 0; i < WS_HANDSHAKE_FRAME_BUFFER; i += 1) socket.emit("message", '"x"')
    socket.emit("message", JSON.stringify({ type: "join", cleanupId: ROOM }))
    await flush()

    expect(socket.framesOfType("presence_snapshot")).toHaveLength(0)
    expect(chat.roomSize(ROOM)).toBe(0)
  })

  it("a join that fits under BOTH bounds is still applied (the caps are not off-by-one)", async () => {
    const handler = captureGatewayHandler(baseOpts())
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, authedRequest(ALICE))
    for (let i = 0; i < WS_HANDSHAKE_FRAME_BUFFER - 1; i += 1) socket.emit("message", '"x"')
    socket.emit("message", JSON.stringify({ type: "join", cleanupId: ROOM }))
    await flush()

    expect(socket.framesOfType("presence_snapshot")).toHaveLength(1)
    expect(chat.roomSize(ROOM)).toBe(1)
  })

  it("frames arriving after the session is live still dispatch (the handover works)", async () => {
    const handler = captureGatewayHandler(baseOpts())
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, authedRequest(ALICE))
    await flush()
    socket.emit("message", JSON.stringify({ type: "join", cleanupId: ROOM }))
    await flush()

    expect(socket.framesOfType("presence_snapshot")).toHaveLength(1)
  })
})

describe("per-user connection cap and slot release", () => {
  /**
   * Open one socket for ALICE. Each call uses its OWN source address (ipN) so the per-IP ceiling can
   * never be what rejects a socket here — these tests are about MAX_CONNECTIONS_PER_USER alone.
   */
  let opened = 0
  async function open(
    handler: (socket: WebSocket, request: FastifyRequest) => void,
  ): Promise<MockSocket> {
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, authedRequest(ALICE, ipN(opened++)))
    await flush()
    return socket
  }

  beforeEach(() => {
    opened = 0
  })

  it("rejects the (cap+1)-th socket for the same user and keeps the first cap alive", async () => {
    const handler = captureGatewayHandler(baseOpts())
    const sockets: MockSocket[] = []
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i += 1) sockets.push(await open(handler))
    for (const s of sockets) expect(s.closes).toHaveLength(0)

    const rejected = await open(handler)
    expect(rejected.framesOfType("error")[0]).toMatchObject({ code: "RATE_LIMITED" })
    expect(rejected.closes).toHaveLength(1)
    expect(rejected.closes[0]?.code).toBe(1008)
  })

  it("rejects the (cap+1)-th socket for the same IP even though every user is under their own cap", async () => {
    // MAX_CONNECTIONS_PER_IP distinct users behind one NAT, one socket each: nobody is near the per-user
    // ceiling, so only the IP counter can reject the next one.
    const handler = captureGatewayHandler(baseOpts())
    const shared = "203.0.113.44"
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i += 1) {
      const socket = new MockSocket()
      handler(socket as unknown as WebSocket, authedRequest(userN(i), shared))
      await flush()
      expect(socket.closes).toHaveLength(0)
    }

    const rejected = new MockSocket()
    handler(rejected as unknown as WebSocket, authedRequest(userN(MAX_CONNECTIONS_PER_IP), shared))
    await flush()
    expect(rejected.framesOfType("error")[0]).toMatchObject({ code: "RATE_LIMITED" })
    expect(rejected.closes[0]?.code).toBe(1008)

    // Same fresh user from a DIFFERENT address is admitted: the rejection was the IP bucket, not the user.
    const elsewhere = new MockSocket()
    handler(
      elsewhere as unknown as WebSocket,
      authedRequest(userN(MAX_CONNECTIONS_PER_IP), "203.0.113.45"),
    )
    await flush()
    expect(elsewhere.closes).toHaveLength(0)
    expect(elsewhere.framesOfType("error")).toHaveLength(0)
  })

  it("closing a socket frees exactly ONE slot, however many close events it fires", async () => {
    const handler = captureGatewayHandler(baseOpts())
    const sockets: MockSocket[] = []
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i += 1) sockets.push(await open(handler))

    // A double close (ws can emit close after an error, and the gateway registers two listeners) must
    // not decrement the counter twice — that would hand out a slot the user does not hold.
    sockets[0]!.emit("close")
    sockets[0]!.emit("close")
    await flush()

    const replacement = await open(handler)
    expect(replacement.closes).toHaveLength(0)
    const overCap = await open(handler)
    expect(overCap.framesOfType("error")[0]).toMatchObject({ code: "RATE_LIMITED" })
  })

  it("a socket that dies DURING subscribeUserChannel releases its slot (and its subscription)", async () => {
    // Hold subscribeUser pending so the socket can close inside the handshake's last await, before any
    // "close" listener that could release the slot exists.
    const racing = new FakeUserChannel()
    let release: (() => void) | undefined
    const realSubscribe = racing.subscribeUser.bind(racing)
    racing.subscribeUser = (userId, conn) =>
      new Promise((resolve) => {
        release = () => resolve(realSubscribe(userId, conn))
      })

    const handler = captureGatewayHandler(baseOpts({ userChannel: racing }))
    const dying = new MockSocket()
    handler(dying as unknown as WebSocket, authedRequest(ALICE))
    await flush()
    dying.readyState = WS_CLOSED
    release!()
    await flush()
    await flush()

    expect(racing.subscriberCount(ALICE)).toBe(0)
    // The slot came back: a full cap's worth of sockets still opens afterwards.
    const later: MockSocket[] = []
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i += 1) later.push(await open(handler))
    for (const s of later) expect(s.closes).toHaveLength(0)
  })
})

/**
 * A socket that dies while handleJoin is still awaiting joinRoom used to leak: the close handler walks
 * `session.joined`, which does not yet contain the room, and the join then registers the DEAD connection in
 * the room's Set afterwards — so the Set never reaches 0 and the room's pub/sub subscription (and the
 * ChatConnection) leaked for the process lifetime. Presence self-heals in 90s; the room Set does not.
 * The fix is `session.closed`, re-checked after every await in handleJoin.
 */
describe("socket close DURING an in-flight join", () => {
  /** Delegating ChatService whose joinRoom parks until `gate.release()` is called. */
  function gatedChat(gate: { release?: () => void }): GatewayOptions["chat"] {
    return {
      joinRoom: (roomKey: string, conn: unknown, userId: string) =>
        new Promise<void>((resolve) => {
          gate.release = () =>
            resolve(chat.joinRoom(roomKey, conn as Parameters<WsChatService["joinRoom"]>[1], userId))
        }),
      leaveRoom: (roomKey: string, conn: unknown) =>
        chat.leaveRoom(roomKey, conn as Parameters<WsChatService["leaveRoom"]>[1]),
      persist: (input: unknown) => chat.persist(input as Parameters<WsChatService["persist"]>[0]),
      history: (...args: unknown[]) =>
        (chat.history as (...a: unknown[]) => unknown)(...args),
      broadcast: (...args: unknown[]) =>
        (chat.broadcast as (...a: unknown[]) => unknown)(...args),
      broadcastEvent: (...args: unknown[]) =>
        (chat.broadcastEvent as (...a: unknown[]) => unknown)(...args),
    } as unknown as GatewayOptions["chat"]
  }

  async function joinThenSettle(opts: { close: boolean; withPresence: boolean }): Promise<void> {
    const gate: { release?: () => void } = {}
    const handler = captureGatewayHandler(
      baseOpts({
        chat: gatedChat(gate),
        ...(opts.withPresence ? {} : { presence: undefined }),
      }),
    )
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, authedRequest(ALICE))
    await flush()

    socket.emit("message", JSON.stringify({ type: "join", cleanupId: ROOM }))
    await flush()
    expect(gate.release).toBeTypeOf("function") // parked inside joinRoom

    if (opts.close) {
      socket.readyState = WS_CLOSED
      socket.emit("close")
    }
    gate.release!()
    await flush()
    await flush()
  }

  it("un-does the join so the room Set can empty (no leaked connection or subscription)", async () => {
    await joinThenSettle({ close: true, withPresence: true })

    expect(chat.roomSize(ROOM)).toBe(0)
    expect(await presence.online(ROOM)).toEqual([])
  })

  it("un-does it with NO presence dep too — the post-joinRoom check is the one that must catch it", async () => {
    // Presence-less on purpose: the later `session.closed` check inside the presence branch also unwinds
    // the room, so a presence-wired test alone cannot tell whether the FIRST post-joinRoom check exists.
    await joinThenSettle({ close: true, withPresence: false })

    expect(chat.roomSize(ROOM)).toBe(0)
  })

  it("without the close the SAME flow really does join (the harness is not vacuous)", async () => {
    await joinThenSettle({ close: false, withPresence: true })

    expect(chat.roomSize(ROOM)).toBe(1)
    expect(await presence.online(ROOM)).toEqual([ALICE])
  })
})

describe("outbound backpressure (wrapSocket)", () => {
  const typing = JSON.stringify({ type: "typing", cleanupId: ROOM, userId: ALICE })
  const message = JSON.stringify({ type: "message", cleanupId: ROOM, message: { id: "m1" } })

  it("drops droppable frame types once the outbound buffer is over threshold, keeps messages", () => {
    const socket = new MockSocket()
    socket.bufferedAmount = WS_BUFFER_DROP_THRESHOLD + 1
    const conn = wrapSocket(socket as unknown as WebSocket)

    conn.send(typing)
    conn.send(JSON.stringify({ type: "presence", cleanupId: ROOM, userId: ALICE, state: "join" }))
    conn.send(JSON.stringify({ type: "presence_snapshot", cleanupId: ROOM, userIds: [] }))
    expect(socket.sent).toHaveLength(0)

    // Content frames are never dropped: losing one loses a message.
    conn.send(message)
    conn.send(JSON.stringify({ type: "ack", clientId: "c1" }))
    conn.send(JSON.stringify({ type: "error", code: "BAD_FRAME", message: "nope" }))
    expect(socket.sent).toHaveLength(3)
  })

  it("drops nothing while the buffer is under threshold", () => {
    const socket = new MockSocket()
    socket.bufferedAmount = WS_BUFFER_DROP_THRESHOLD
    const conn = wrapSocket(socket as unknown as WebSocket)
    conn.send(typing)
    conn.send(message)
    expect(socket.sent).toHaveLength(2)
  })

  it("classifies on the frame's OWN type, not a 'type' spelled inside user content", () => {
    const socket = new MockSocket()
    socket.bufferedAmount = WS_BUFFER_DROP_THRESHOLD + 1
    const conn = wrapSocket(socket as unknown as WebSocket)
    // A member pasted a frame into chat: the droppable word appears in the BODY, after the real type.
    conn.send(
      JSON.stringify({
        type: "message",
        cleanupId: ROOM,
        message: { id: "m1", body: '{"type":"typing"}' },
      }),
    )
    expect(socket.sent).toHaveLength(1)
  })

  it("sends nothing on a socket that is no longer OPEN", () => {
    const socket = new MockSocket()
    socket.readyState = WS_CLOSED
    const conn = wrapSocket(socket as unknown as WebSocket)
    conn.send(message)
    expect(socket.sent).toHaveLength(0)
  })

  /**
   * The three heartbeat outcomes are pinned as a set, because they are mutually confusable: every one of
   * them ends in `terminate()`, so a single "it terminated" assertion cannot say WHY. The survive case
   * below establishes that an answered ping really does keep a socket alive indefinitely — which is what
   * makes the backpressure case's terminate attributable to the buffer rather than to a missed pong.
   */
  it("a responsive socket with a drained buffer is NEVER terminated, however many ticks pass", async () => {
    vi.useFakeTimers()
    try {
      const handler = captureGatewayHandler(baseOpts())
      const socket = new MockSocket()
      handler(socket as unknown as WebSocket, authedRequest(ALICE))
      await microflush()

      const ticks = WS_BUFFER_TERMINATE_TICKS + 3
      for (let i = 0; i < ticks; i += 1) await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
      expect(socket.terminated).toBe(0)
      expect(socket.pings).toBe(ticks)
    } finally {
      vi.useRealTimers()
    }
  })

  it("the heartbeat terminates a socket that stays over threshold, even while it answers pings", async () => {
    vi.useFakeTimers()
    try {
      const handler = captureGatewayHandler(baseOpts())
      const socket = new MockSocket()
      handler(socket as unknown as WebSocket, authedRequest(ALICE))
      await microflush()

      socket.bufferedAmount = WS_BUFFER_DROP_THRESHOLD + 1
      for (let tick = 1; tick < WS_BUFFER_TERMINATE_TICKS; tick += 1) {
        await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
        expect(socket.terminated).toBe(0)
        // The client is responsive — this is the backpressure path, not the missed-pong one.
        expect(socket.pings).toBe(tick)
      }
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
      expect(socket.terminated).toBe(1)
      // Terminated at the TOP of the tick, before that tick's ping: the buffer check short-circuits.
      expect(socket.pings).toBe(WS_BUFFER_TERMINATE_TICKS - 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a socket that stops answering pings is terminated on the next tick (missed-pong path)", async () => {
    vi.useFakeTimers()
    try {
      const handler = captureGatewayHandler(baseOpts())
      const socket = new MockSocket()
      socket.respondToPing = false
      handler(socket as unknown as WebSocket, authedRequest(ALICE))
      await microflush()

      // Tick 1 pings and clears `alive`; with no pong back, tick 2 terminates — with the buffer EMPTY the
      // whole time, so this is the liveness path and not the backpressure one.
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
      expect(socket.terminated).toBe(0)
      expect(socket.pings).toBe(1)
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
      expect(socket.terminated).toBe(1)
      expect(socket.bufferedAmount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a drained socket resets its over-buffer streak", async () => {
    vi.useFakeTimers()
    try {
      const handler = captureGatewayHandler(baseOpts())
      const socket = new MockSocket()
      handler(socket as unknown as WebSocket, authedRequest(ALICE))
      await microflush()

      socket.bufferedAmount = WS_BUFFER_DROP_THRESHOLD + 1
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
      socket.bufferedAmount = 0
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
      socket.bufferedAmount = WS_BUFFER_DROP_THRESHOLD + 1
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
      expect(socket.terminated).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("send limiter routes each room kind to its own bucket", () => {
  let consumed: string[]
  let reportBucket: RateLimiter

  beforeEach(() => {
    consumed = []
    // Exhausted on purpose: a send that reaches this bucket is answered RATE_LIMITED before any query,
    // which is exactly what makes the routing observable.
    reportBucket = {
      tryConsume(key: string): boolean {
        consumed.push(key)
        return false
      },
    }
  })

  async function sendFrame(frame: Record<string, unknown>): Promise<MockSocket> {
    const handler = captureGatewayHandler(
      baseOpts({ reportSendLimiter: reportBucket, reportVisible: () => Promise.resolve(true) }),
    )
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, authedRequest(ALICE))
    await flush()
    socket.emit("message", JSON.stringify(frame))
    await flush()
    return socket
  }

  it("a REPORT send spends the injected report bucket, keyed by user + room", async () => {
    const socket = await sendFrame({
      type: "send",
      roomKind: "report",
      cleanupId: ROOM,
      clientId: "c1",
      body: "hi",
    })
    expect(consumed).toEqual([`${ALICE}:report:${ROOM}`])
    expect(socket.framesOfType("error")[0]).toMatchObject({ code: "RATE_LIMITED" })
  })

  it("a CLEANUP send never touches the report bucket", async () => {
    const socket = await sendFrame({ type: "send", cleanupId: ROOM, clientId: "c1", body: "hi" })
    expect(consumed).toEqual([])
    expect(socket.framesOfType("ack")).toHaveLength(1)
  })

  it("a DM send never touches the report bucket", async () => {
    const socket = await sendFrame({
      type: "send",
      roomKind: "dm",
      cleanupId: ROOM,
      clientId: "c1",
      body: "hi",
    })
    expect(consumed).toEqual([])
    // No dm deps wired, so it stops at authorization — past the limiter, which is the point.
    expect(socket.framesOfType("error")[0]).toMatchObject({ code: "FORBIDDEN" })
  })

  it("a GROUP send never touches the report bucket (group rooms share the cleanup bucket shape)", async () => {
    const socket = await sendFrame({
      type: "send",
      roomKind: "group",
      cleanupId: ROOM,
      clientId: "c1",
      body: "hi",
    })
    expect(consumed).toEqual([])
    // No groupChat deps wired, so it fails closed at authorization — again, past the limiter.
    expect(socket.framesOfType("error")[0]).toMatchObject({ code: "FORBIDDEN" })
  })
})
