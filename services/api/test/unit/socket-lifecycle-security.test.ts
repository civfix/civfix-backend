import { describe, it, expect, beforeEach } from "vitest"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { WebSocket } from "@fastify/websocket"
import { registerChatGateway } from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatRepository } from "../helpers/chat.js"
import {
  WS_CLOSE_POLICY_VIOLATION,
  WS_FRAME_LIMIT,
  WS_MAX_JOINED_ROOMS,
  WS_MAX_QUEUED_BYTES,
  WS_MAX_QUEUED_FRAMES,
} from "../../src/ws/types.js"

const WS_OPEN = 1
const WS_CLOSED = 3
const ALICE = "11111111-1111-1111-1111-111111111111"
const FLOOD_FRAMES = 100
const MAX_PAYLOAD_BYTES = 64 * 1024

class MockSocket {
  readyState = WS_OPEN
  bufferedAmount = 0
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
    this.readyState = WS_CLOSED
  }

  ping(): void {
    this.emit("pong")
  }
}

function roomN(n: number): string {
  return `aaaaaaaa-aaaa-aaaa-aaaa-${String(n).padStart(12, "0")}`
}

function joinFrame(n: number): string {
  return JSON.stringify({ type: "join", cleanupId: roomN(n) })
}

function authedRequest(): FastifyRequest {
  return {
    auth: { userId: ALICE },
    ip: "203.0.113.7",
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

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

interface StalledMembership {
  calls: string[]
  release(): void
  isMember(cleanupId: string, userId: string): Promise<boolean>
}

function stalledMembership(): StalledMembership {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const state: StalledMembership = {
    calls: [],
    release: () => release(),
    async isMember(cleanupId) {
      state.calls.push(cleanupId)
      if (state.calls.length === 1) await gate
      return false
    },
  }
  return state
}

async function openLiveSocket(membership: StalledMembership): Promise<MockSocket> {
  const handler = captureGatewayHandler({
    chat: new WsChatService({
      repo: new InMemoryChatRepository(),
      pubsub: new InMemoryChatPubSub(),
    }),
    isMember: (cleanupId, userId) => membership.isMember(cleanupId, userId),
    sessions: undefined,
    webOrigins: [],
  })
  const socket = new MockSocket()
  handler(socket, authedRequest())
  await flush()
  return socket
}

describe("post-handshake inbound frame backlog is bounded", () => {
  let membership: StalledMembership

  beforeEach(() => {
    membership = stalledMembership()
  })

  it("closes the socket with a policy violation once the backlog passes the frame cap", async () => {
    const socket = await openLiveSocket(membership)
    socket.emit("message", joinFrame(0))
    await flush()
    for (let i = 1; i <= FLOOD_FRAMES; i += 1) socket.emit("message", joinFrame(i))

    expect(socket.closes).toHaveLength(1)
    expect(socket.closes[0]?.code).toBe(WS_CLOSE_POLICY_VIOLATION)

    membership.release()
    for (let i = 0; i < 10; i += 1) await flush()
    expect(membership.calls.length).toBeLessThanOrEqual(WS_MAX_QUEUED_FRAMES)
  })

  it("closes the socket once the queued bytes pass the byte cap, even under the frame cap", async () => {
    const socket = await openLiveSocket(membership)
    socket.emit("message", joinFrame(0))
    await flush()
    const filler = JSON.stringify("x".repeat(MAX_PAYLOAD_BYTES - 2))
    const framesToOverflow = Math.ceil(WS_MAX_QUEUED_BYTES / MAX_PAYLOAD_BYTES) + 1
    expect(framesToOverflow).toBeLessThan(WS_MAX_QUEUED_FRAMES)
    for (let i = 0; i < framesToOverflow; i += 1) socket.emit("message", filler)

    expect(socket.closes).toHaveLength(1)
    expect(socket.closes[0]?.code).toBe(WS_CLOSE_POLICY_VIOLATION)
  })

  it("keeps a backlog under the cap open and drains it in arrival order", async () => {
    const socket = await openLiveSocket(membership)
    socket.emit("message", joinFrame(0))
    await flush()
    const queued = WS_MAX_QUEUED_FRAMES - 1
    for (let i = 1; i <= queued; i += 1) socket.emit("message", joinFrame(i))

    membership.release()
    for (let i = 0; i < 10; i += 1) await flush()

    expect(socket.closes).toHaveLength(0)
    const admittedByBucket = Math.min(queued + 1, WS_FRAME_LIMIT.capacity)
    expect(membership.calls).toEqual(Array.from({ length: admittedByBucket }, (_, i) => roomN(i)))
  })

  it("keeps a full token-bucket burst or a full room re-join open behind one slow handler", async () => {
    const socket = await openLiveSocket(membership)
    const burst = Math.max(WS_FRAME_LIMIT.capacity, WS_MAX_JOINED_ROOMS)
    socket.emit("message", joinFrame(0))
    await flush()
    for (let i = 1; i < burst; i += 1) socket.emit("message", joinFrame(i))

    expect(socket.closes).toHaveLength(0)
    membership.release()
    for (let i = 0; i < 10; i += 1) await flush()
    expect(socket.closes).toHaveLength(0)
    expect(membership.calls.length).toBeGreaterThanOrEqual(WS_FRAME_LIMIT.capacity)
  })

  it("frees backlog room as frames finish, so a drained socket takes a new burst", async () => {
    const socket = await openLiveSocket(membership)
    socket.emit("message", joinFrame(0))
    await flush()
    const burst = WS_MAX_QUEUED_FRAMES - 1
    for (let i = 1; i <= burst; i += 1) socket.emit("message", joinFrame(i))
    membership.release()
    for (let i = 0; i < 10; i += 1) await flush()

    for (let i = 1; i <= burst; i += 1) socket.emit("message", joinFrame(burst + i))
    for (let i = 0; i < 10; i += 1) await flush()

    expect(socket.closes).toHaveLength(0)
  })
})
