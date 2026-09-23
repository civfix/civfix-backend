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
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { SessionService } from "../../src/auth/session-service.js"
import { makeWsTicketStore } from "../../src/auth/ws-ticket.js"
import { sha256Hex } from "../../src/auth/crypto.js"
import {
  WS_CLOSE_POLICY_VIOLATION,
  WS_FRAME_LIMIT,
  WS_MAX_QUEUED_FRAMES,
  WS_REAUTH_INTERVAL_MS,
  WS_REAUTH_JITTER_MS,
} from "../../src/ws/types.js"
import { SESSION_COOKIE } from "../../src/auth/transport.js"

const WS_OPEN = 1
const WS_CLOSED = 3

const FULL_REAUTH_HEARTBEATS = Math.ceil(
  (WS_REAUTH_INTERVAL_MS + WS_REAUTH_JITTER_MS) / WS_HEARTBEAT_MS,
)

const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ALICE = "11111111-1111-1111-1111-111111111111"

function userN(n: number): string {
  return `2222${String(n).padStart(4, "0")}-2222-2222-2222-222222222222`
}

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

function memberOf(cleanupId: string, userId: string): Promise<boolean> {
  return Promise.resolve(cleanupId === ROOM && userId === ALICE)
}

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

function cookieRequest(userId: string, token: string, ip = "203.0.113.10"): FastifyRequest {
  return {
    auth: { userId },
    ip,
    headers: {},
    cookies: { [SESSION_COOKIE]: token },
    query: {},
    log: { warn() {}, error() {}, info() {}, debug() {} },
  } as unknown as FastifyRequest
}

function ticketRequest(ticket: string, ip = "203.0.113.9"): FastifyRequest {
  return {
    ip,
    headers: {},
    cookies: {},
    query: { ticket },
    log: { warn() {}, error() {}, info() {}, debug() {} },
  } as unknown as FastifyRequest
}

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

const realSetTimeout = globalThis.setTimeout
const realNowMs = performance.now.bind(performance)

const SETTLE_BUDGET_MS = 10_000

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

function realTick(): Promise<void> {
  return new Promise<void>((resolve) => {
    realSetTimeout(resolve, 1)
  })
}

async function microflush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1)
    else await flush()
  }
}

async function settleUntil(done: () => boolean, budgetMs = SETTLE_BUDGET_MS): Promise<void> {
  const deadline = realNowMs() + budgetMs
  for (;;) {
    if (done()) return
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1)
    else await flush()
    if (done()) return
    if (realNowMs() >= deadline) {
      throw new Error("settleUntil: condition never became true")
    }
    await realTick()
  }
}

describe("frames sent during the async handshake are buffered, not dropped", () => {
  it("a join sent before the handshake settles is applied once the session exists", async () => {
    const handler = captureGatewayHandler(baseOpts())
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, authedRequest(ALICE))
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

  it("stops buffering past the BYTE ceiling (a legit join behind 64 KiB of junk is dropped)", async () => {
    const handler = captureGatewayHandler(baseOpts())
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, authedRequest(ALICE))
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
    for (let i = 0; i < WS_HANDSHAKE_FRAME_BUFFER; i += 1) socket.emit("message", '"x"')
    socket.emit("message", JSON.stringify({ type: "join", cleanupId: ROOM }))
    await flush()

    expect(socket.framesOfType("presence_snapshot")).toHaveLength(0)
    expect(chat.roomSize(ROOM)).toBe(0)
  })

  it("a join that fits under BOTH bounds is still buffered and answered (the caps are not off-by-one)", async () => {
    const handler = captureGatewayHandler(baseOpts())
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, authedRequest(ALICE))
    for (let i = 0; i < WS_HANDSHAKE_FRAME_BUFFER - 1; i += 1) socket.emit("message", '"x"')
    socket.emit("message", JSON.stringify({ type: "join", cleanupId: ROOM }))
    await flush()

    const answers = socket.framesOfType("error")
    expect(answers).toHaveLength(WS_HANDSHAKE_FRAME_BUFFER)
    expect(answers.at(-1)).toMatchObject({ code: "RATE_LIMITED" })
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

describe("the pre-auth buffer holds as many frames as the post-auth queue", () => {
  const DRAIN_BUDGET_MS = 1_000
  const roomN = (n: number): string =>
    `bbbb${String(n).padStart(4, "0")}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`

  function pipelineJoins(count: number): MockSocket {
    const handler = captureGatewayHandler(baseOpts({ isMember: () => Promise.resolve(true) }))
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, authedRequest(ALICE))
    for (let i = 0; i < count; i += 1) {
      socket.emit("message", JSON.stringify({ type: "join", cleanupId: roomN(i) }))
    }
    return socket
  }

  it("sizes the handshake buffer from the post-auth frame cap", () => {
    expect(WS_HANDSHAKE_FRAME_BUFFER).toBe(WS_MAX_QUEUED_FRAMES)
  })

  it("applies a full frame-bucket burst of joins pipelined before auth", async () => {
    const socket = pipelineJoins(WS_FRAME_LIMIT.capacity)
    await settleUntil(
      () => socket.framesOfType("presence_snapshot").length >= WS_FRAME_LIMIT.capacity,
      DRAIN_BUDGET_MS,
    ).catch(() => undefined)

    expect(socket.framesOfType("presence_snapshot")).toHaveLength(WS_FRAME_LIMIT.capacity)
    expect(socket.framesOfType("error")).toHaveLength(0)
  })

  it("answers every buffered frame past the burst instead of dropping it silently", async () => {
    const socket = pipelineJoins(WS_MAX_QUEUED_FRAMES)
    const answered = (): number =>
      socket.framesOfType("presence_snapshot").length + socket.framesOfType("error").length
    await settleUntil(() => answered() >= WS_MAX_QUEUED_FRAMES, DRAIN_BUDGET_MS).catch(
      () => undefined,
    )

    expect(socket.framesOfType("presence_snapshot")).toHaveLength(WS_FRAME_LIMIT.capacity)
    const limited = socket.framesOfType("error")
    expect(limited).toHaveLength(WS_MAX_QUEUED_FRAMES - WS_FRAME_LIMIT.capacity)
    expect(limited.every((f) => f.code === "RATE_LIMITED")).toBe(true)
  })
})

describe("per-user connection cap and slot release", () => {
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

    sockets[0]!.emit("close")
    sockets[0]!.emit("close")
    await flush()

    const replacement = await open(handler)
    expect(replacement.closes).toHaveLength(0)
    const overCap = await open(handler)
    expect(overCap.framesOfType("error")[0]).toMatchObject({ code: "RATE_LIMITED" })
  })

  it("a socket that dies DURING subscribeUserChannel releases its slot (and its subscription)", async () => {
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
    const later: MockSocket[] = []
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i += 1) later.push(await open(handler))
    for (const s of later) expect(s.closes).toHaveLength(0)
  })
})

describe("socket close DURING an in-flight join", () => {
  function gatedChat(gate: { release?: () => void }): GatewayOptions["chat"] {
    return {
      joinRoom: (roomKey: string, conn: unknown, userId: string) =>
        new Promise<void>((resolve) => {
          gate.release = () =>
            resolve(
              chat.joinRoom(roomKey, conn as Parameters<WsChatService["joinRoom"]>[1], userId),
            )
        }),
      leaveRoom: (roomKey: string, conn: unknown) =>
        chat.leaveRoom(roomKey, conn as Parameters<WsChatService["leaveRoom"]>[1]),
      persist: (input: unknown) => chat.persist(input as Parameters<WsChatService["persist"]>[0]),
      history: (...args: unknown[]) => (chat.history as (...a: unknown[]) => unknown)(...args),
      broadcast: (...args: unknown[]) => (chat.broadcast as (...a: unknown[]) => unknown)(...args),
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
    expect(gate.release).toBeTypeOf("function")

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

  it("un-does it with NO presence dep too; the post-joinRoom check is the one that must catch it", async () => {
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
        expect(socket.pings).toBe(tick)
      }
      await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
      expect(socket.terminated).toBe(1)
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
    reportBucket = {
      tryConsume(key: string): boolean {
        consumed.push(key)
        return false
      },
    }
  })

  const reportMember: GatewayOptions["reportChat"] = {
    isMember: () => Promise.resolve(true),
    advanceReadWatermark: () => Promise.resolve(),
  }

  async function sendFrame(
    frame: Record<string, unknown>,
    over: Partial<GatewayOptions> = {},
  ): Promise<MockSocket> {
    const handler = captureGatewayHandler(
      baseOpts({
        reportSendLimiter: reportBucket,
        reportVisible: () => Promise.resolve(true),
        reportChat: reportMember,
        ...over,
      }),
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

  it("F042: an UNAUTHORIZED report send creates no bucket key (authorization gates first)", async () => {
    const socket = await sendFrame(
      { type: "send", roomKind: "report", cleanupId: ROOM, clientId: "c1", body: "hi" },
      {
        reportChat: {
          isMember: () => Promise.resolve(false),
          advanceReadWatermark: () => Promise.resolve(),
        },
      },
    )
    expect(consumed).toEqual([])
    expect(socket.framesOfType("error")[0]).toMatchObject({ code: "FORBIDDEN" })
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
    expect(socket.framesOfType("error")[0]).toMatchObject({ code: "FORBIDDEN" })
  })
})

describe("F038: post-handshake frames are dispatched in wire order, one at a time", () => {
  function orderedPersistChat(gate: { release?: () => void }): GatewayOptions["chat"] {
    return {
      joinRoom: (...a: unknown[]) => (chat.joinRoom as (...x: unknown[]) => unknown)(...a),
      leaveRoom: (...a: unknown[]) => (chat.leaveRoom as (...x: unknown[]) => unknown)(...a),
      persist: (input: { body?: string }) => {
        if (input.body === "first") {
          return new Promise((resolve) => {
            gate.release = () => resolve((chat.persist as (i: unknown) => unknown)(input))
          })
        }
        return (chat.persist as (i: unknown) => unknown)(input)
      },
      history: (...a: unknown[]) => (chat.history as (...x: unknown[]) => unknown)(...a),
      broadcast: (...a: unknown[]) => (chat.broadcast as (...x: unknown[]) => unknown)(...a),
      broadcastEvent: (...a: unknown[]) =>
        (chat.broadcastEvent as (...x: unknown[]) => unknown)(...a),
    } as unknown as GatewayOptions["chat"]
  }

  it("a slow first send blocks the second, then both ack in order (no interleaving)", async () => {
    const gate: { release?: () => void } = {}
    const handler = captureGatewayHandler(baseOpts({ chat: orderedPersistChat(gate) }))
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, authedRequest(ALICE))
    await flush()

    socket.emit(
      "message",
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c1", body: "first" }),
    )
    socket.emit(
      "message",
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c2", body: "second" }),
    )
    await flush()

    expect(gate.release).toBeTypeOf("function")
    expect(socket.framesOfType("ack")).toHaveLength(0)

    gate.release!()
    await flush()

    const acks = socket.framesOfType("ack")
    expect(acks.map((a) => a.clientId)).toEqual(["c1", "c2"])
    expect(repo.count(ROOM)).toBe(2)
  })
})

describe("F022: the heartbeat re-authorizes joined rooms and evicts a revoked member", () => {
  it("drops a socket from a room once its membership is revoked", async () => {
    vi.useFakeTimers()
    try {
      let allowed = true
      const isMember = (cleanupId: string, userId: string): Promise<boolean> =>
        Promise.resolve(cleanupId === ROOM && userId === ALICE && allowed)
      const handler = captureGatewayHandler(baseOpts({ isMember }))
      const socket = new MockSocket()
      handler(socket as unknown as WebSocket, authedRequest(ALICE))
      await microflush()
      socket.emit("message", JSON.stringify({ type: "join", cleanupId: ROOM }))
      await microflush()
      expect(chat.roomSize(ROOM)).toBe(1)

      allowed = false
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)

      expect(chat.roomSize(ROOM)).toBe(0)
      expect(await presence.online(ROOM)).toEqual([])
      expect(socket.framesOfType("error").some((f) => f.code === "FORBIDDEN")).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps a still-authorized socket joined across many heartbeats", async () => {
    vi.useFakeTimers()
    try {
      const handler = captureGatewayHandler(baseOpts())
      const socket = new MockSocket()
      handler(socket as unknown as WebSocket, authedRequest(ALICE))
      await microflush()
      socket.emit("message", JSON.stringify({ type: "join", cleanupId: ROOM }))
      await microflush()

      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)

      expect(chat.roomSize(ROOM)).toBe(1)
      expect(socket.framesOfType("error")).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("H2: a ?ticket socket is re-validated against session revocation, exactly like a cookie socket", () => {
  const REAUTH_TICKS = 5

  async function ticketSocket(): Promise<{
    sessions: SessionService
    socket: MockSocket
    token: string
  }> {
    const stores = makeInMemoryStores()
    const cache = new InMemoryCacheClient(() => Date.now())
    const sessions = new SessionService({ store: stores.sessions, cache, now: () => Date.now() })
    const token = await sessions.createSession(ALICE, ["citizen"])
    const tickets = makeWsTicketStore(cache)
    const { ticket } = await tickets.mint(ALICE, await sha256Hex(token))

    const handler = captureGatewayHandler(
      baseOpts({ sessions, redeemTicket: (t) => tickets.redeem(t) }),
    )
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, ticketRequest(ticket))
    await settleUntil(() => vi.getTimerCount() > 0 || socket.closes.length > 0)
    return { sessions, socket, token }
  }

  async function beatHeartbeat(): Promise<void> {
    for (let i = 0; i < REAUTH_TICKS; i += 1) await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
  }

  it("closes the socket after revokeAllForUser (admin revoke / role change)", async () => {
    vi.useFakeTimers()
    try {
      const { sessions, socket } = await ticketSocket()
      expect(socket.closes).toHaveLength(0)

      await sessions.revokeAllForUser(ALICE)
      await beatHeartbeat()

      expect(socket.closes).toHaveLength(1)
      expect(socket.closes[0]?.reason).toBe("session no longer valid")
      expect(socket.framesOfType("error").at(-1)).toMatchObject({ code: "UNAUTHORIZED" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("closes the socket after the minting session is revoked by logout", async () => {
    vi.useFakeTimers()
    try {
      const { sessions, socket, token } = await ticketSocket()
      await sessions.revokeSession(token)
      await beatHeartbeat()
      expect(socket.closes).toHaveLength(1)
      expect(socket.closes[0]?.code).toBe(WS_CLOSE_POLICY_VIOLATION)
    } finally {
      vi.useRealTimers()
    }
  })

  it("leaves a live ticket socket open, and refreshes its account status from the re-check", async () => {
    vi.useFakeTimers()
    try {
      const { sessions, socket } = await ticketSocket()
      await beatHeartbeat()
      expect(socket.closes).toHaveLength(0)
      expect(await sessions.isUserActive(ALICE)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("refuses the handshake outright when the bound session is already gone", async () => {
    const stores = makeInMemoryStores()
    const cache = new InMemoryCacheClient(() => Date.now())
    const sessions = new SessionService({ store: stores.sessions, cache, now: () => Date.now() })
    const token = await sessions.createSession(ALICE, ["citizen"])
    const tickets = makeWsTicketStore(cache)
    const { ticket } = await tickets.mint(ALICE, await sha256Hex(token))
    await sessions.revokeAllForUser(ALICE)

    const handler = captureGatewayHandler(
      baseOpts({ sessions, redeemTicket: (t) => tickets.redeem(t) }),
    )
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, ticketRequest(ticket))
    await settleUntil(() => socket.closes.length > 0)

    expect(socket.closes).toHaveLength(1)
    expect(socket.closes[0]?.reason).toBe("unauthenticated")
  })
})

describe("H3: the cookie socket honours the revocation epoch even when the Redis eviction failed", () => {
  class FailingDelCache extends InMemoryCacheClient {
    failDel = false
    override del(key: string): Promise<void> {
      if (this.failDel) return Promise.reject(new Error("redis del down"))
      return super.del(key)
    }
  }

  it("closes a cookie socket after revokeAllForUser strands its sess:<hash> projection", async () => {
    vi.useFakeTimers()
    try {
      const stores = makeInMemoryStores()
      const cache = new FailingDelCache(() => Date.now())
      const sessions = new SessionService({
        store: stores.sessions,
        cache,
        now: () => Date.now(),
        logger: { error() {} },
      })
      const token = await sessions.createSession(ALICE, ["citizen"])
      const hash = await sha256Hex(token)

      const handler = captureGatewayHandler(baseOpts({ sessions }))
      const socket = new MockSocket()
      handler(socket as unknown as WebSocket, cookieRequest(ALICE, token))
      await settleUntil(() => vi.getTimerCount() > 0 || socket.closes.length > 0)
      expect(socket.closes).toHaveLength(0)

      cache.failDel = true
      await sessions.revokeAllForUser(ALICE)
      expect(await cache.get(`sess:${hash}`)).not.toBeNull()

      for (let i = 0; i < FULL_REAUTH_HEARTBEATS; i += 1) {
        await vi.advanceTimersByTimeAsync(WS_HEARTBEAT_MS)
      }
      expect(socket.closes).toHaveLength(1)
      expect(socket.closes[0]?.reason).toBe("session no longer valid")
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("NB4: a ticket socket carries a status revalidator so suspension bites on the next send", () => {
  it("refuses a send as soon as the account is suspended, without waiting for the 60-90 s re-check", async () => {
    const stores = makeInMemoryStores()
    const cache = new InMemoryCacheClient(() => Date.now())
    const sessions = new SessionService({ store: stores.sessions, cache, now: () => Date.now() })
    const token = await sessions.createSession(ALICE, ["citizen"])
    const tickets = makeWsTicketStore(cache)
    const { ticket } = await tickets.mint(ALICE, await sha256Hex(token))

    const handler = captureGatewayHandler(
      baseOpts({ sessions, redeemTicket: (t) => tickets.redeem(t) }),
    )
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, ticketRequest(ticket))
    await settle()
    expect(socket.closes).toHaveLength(0)

    socket.emit("message", JSON.stringify({ type: "join", cleanupId: ROOM }))
    await settle()
    socket.sent.length = 0
    socket.emit(
      "message",
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c1", body: "before" }),
    )
    await settle()
    expect(socket.framesOfType("error")).toHaveLength(0)

    stores.sessions.setAccountStatus(ALICE, "suspended")
    await sessions.bumpEpoch(ALICE)

    socket.sent.length = 0
    socket.emit(
      "message",
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c2", body: "after" }),
    )
    await settle()
    const errors = socket.framesOfType("error")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: "FORBIDDEN" })
  })

  it("B3: a console-style suspension (rows deleted + epoch bumped) refuses the very next send and closes the socket", async () => {
    const stores = makeInMemoryStores()
    const cache = new InMemoryCacheClient(() => Date.now())
    const sessions = new SessionService({ store: stores.sessions, cache, now: () => Date.now() })
    const token = await sessions.createSession(ALICE, ["citizen"])
    const tickets = makeWsTicketStore(cache)
    const { ticket } = await tickets.mint(ALICE, await sha256Hex(token))

    const handler = captureGatewayHandler(
      baseOpts({ sessions, redeemTicket: (t) => tickets.redeem(t) }),
    )
    const socket = new MockSocket()
    handler(socket as unknown as WebSocket, ticketRequest(ticket))
    await settle()

    socket.emit("message", JSON.stringify({ type: "join", cleanupId: ROOM }))
    await settle()
    socket.sent.length = 0

    stores.users.setAccountStatus(ALICE, "suspended")
    await sessions.applyAccountStatus(ALICE, "suspended")
    expect(await stores.sessions.findById(await sha256Hex(token))).toBeNull()

    socket.emit(
      "message",
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c1", body: "after suspend" }),
    )
    await settle()

    expect(socket.framesOfType("message")).toHaveLength(0)
    expect(socket.framesOfType("error").at(-1)).toMatchObject({ code: "UNAUTHORIZED" })
    expect(socket.closes).toHaveLength(1)
    expect(socket.closes[0]?.code).toBe(WS_CLOSE_POLICY_VIOLATION)
    expect(socket.closes[0]?.reason).toBe("session no longer valid")
  })
})
