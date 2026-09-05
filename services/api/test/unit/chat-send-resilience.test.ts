import { describe, it, expect, beforeEach } from "vitest"
import type { FastifyBaseLogger } from "fastify"
import type { ChatMessageDTO } from "@civfix/shared"
import {
  handleClientFrame,
  roomKeyFor,
  type GatewayDeps,
  type GatewaySession,
} from "../../src/ws/gateway.js"
import {
  BROADCAST_ATTEMPTS,
  InMemorySendDedupeStore,
  makeRateLimitedWarn,
  makeSendResilience,
  sendDedupeKey,
  type BroadcastFailure,
  type SendDedupeStore,
  type SendReservation,
} from "../../src/ws/send-resilience.js"
import { RedisSendDedupeStore } from "../../src/adapters/chat-send-dedupe.redis.js"
import type { RedisClient } from "../../src/adapters/redis.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import {
  InMemoryChatPubSub,
  type ChatPubSub,
  type ChatPubSubHandler,
} from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatRepository, MockConnection } from "../helpers/chat.js"

const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"

const memberOf = (cleanupId: string, userId: string): Promise<boolean> =>
  Promise.resolve(cleanupId === ROOM && [ALICE, BOB].includes(userId))

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const sendFrame = (clientId: string, body = "hello"): string =>
  JSON.stringify({ type: "send", cleanupId: ROOM, body, clientId })

class RejectingPubSub implements ChatPubSub {
  publishes = 0
  private readonly inner = new InMemoryChatPubSub()

  publish(): Promise<void> {
    this.publishes += 1
    return Promise.reject(new Error("Command timed out"))
  }

  subscribe(channel: string, handler: ChatPubSubHandler): Promise<() => Promise<void>> {
    return this.inner.subscribe(channel, handler)
  }

  close(): Promise<void> {
    return this.inner.close()
  }
}

let repo: InMemoryChatRepository

interface Harness {
  chat: WsChatService
  gatewayChat: GatewayDeps["chat"]
  failures: BroadcastFailure[]
}

function harness(opts: { pubsub?: ChatPubSub; dedupe?: SendDedupeStore | undefined } = {}): Harness {
  const chat = new WsChatService({ repo, pubsub: opts.pubsub ?? new InMemoryChatPubSub() })
  const failures: BroadcastFailure[] = []
  const sendResilience = makeSendResilience({
    dedupe: opts.dedupe,
    findRoomMessage: (_kind, roomId, messageId, viewerUserId) =>
      repo.findMessage(roomId, messageId, viewerUserId),
    deliverLocally: (roomKey, frame, excludeConnId) => chat.deliverLocal(roomKey, frame, excludeConnId),
    onBroadcastFailure: (info) => failures.push(info),
    sleep: () => Promise.resolve(),
    jitter: () => 0,
  })
  const gatewayChat: GatewayDeps["chat"] = {
    joinRoom: (room, conn, userId) => chat.joinRoom(room, conn, userId),
    leaveRoom: (room, conn) => chat.leaveRoom(room, conn),
    persist: (input) => chat.persist(input),
    history: (room, before, limit, viewer, around) => chat.history(room, before, limit, viewer, around),
    broadcast: (room, msg, o) => chat.broadcast(room, msg, o),
    broadcastEvent: (room, frame, o) => chat.broadcastEvent(room, frame, o),
    sendResilience,
  }
  return { chat, gatewayChat, failures }
}

function sessionFor(userId: string, conn: MockConnection, h: Harness): GatewaySession {
  const deps: GatewayDeps = { chat: h.gatewayChat, isMember: memberOf }
  return { userId, conn, joined: new Set<string>(), typingThrottle: new Map<string, number>(), deps }
}

beforeEach(() => {
  repo = new InMemoryChatRepository()
  repo.registerSender({ id: ALICE, displayName: "Alice", handle: "alice" })
  repo.registerSender({ id: BOB, displayName: "Bob", handle: "bob" })
})

describe("H17: a failing Redis publish never fails the sender", () => {
  it("acks with the persisted id and still delivers to same-process sockets", async () => {
    const pubsub = new RejectingPubSub()
    const h = harness({ pubsub })
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const a = sessionFor(ALICE, aConn, h)
    const b = sessionFor(BOB, bConn, h)
    await handleClientFrame(a, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(b, JSON.stringify({ type: "join", cleanupId: ROOM }))

    await handleClientFrame(a, sendFrame("c1"))
    await flush()

    const ack = aConn.framesOfType("ack").at(-1) as { clientId: string; message: ChatMessageDTO }
    expect(ack).toBeTruthy()
    expect(ack.clientId).toBe("c1")
    expect(ack.message.id).toBeTruthy()
    expect(aConn.framesOfType("error")).toEqual([])

    expect(pubsub.publishes).toBe(3)
    const delivered = bConn.framesOfType("message").at(-1) as { message: ChatMessageDTO }
    expect(delivered.message.id).toBe(ack.message.id)
    expect(aConn.framesOfType("message")).toEqual([])

    const history = await repo.history(ROOM, undefined, 50, ALICE)
    expect(history.items).toHaveLength(1)
  })

  it("reports the failure with room + message id only, never the body", async () => {
    const h = harness({ pubsub: new RejectingPubSub() })
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn, h)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(session, sendFrame("c1", "my home address is 123 Fake St"))
    await flush()

    expect(h.failures).toHaveLength(1)
    expect(h.failures[0]!.roomKey).toBe(ROOM)
    expect(h.failures[0]!.attempts).toBe(3)
    expect(h.failures[0]!.localRecipients).toBe(0)
    expect(JSON.stringify(h.failures[0])).not.toContain("home address")
  })

  it("a publish that HANGS is bounded by the per-attempt timeout, then falls back locally", async () => {
    const chat = new WsChatService({ repo, pubsub: new InMemoryChatPubSub() })
    const failures: BroadcastFailure[] = []
    const sendResilience = makeSendResilience({
      deliverLocally: (roomKey, frame, excludeConnId) =>
        chat.deliverLocal(roomKey, frame, excludeConnId),
      onBroadcastFailure: (info) => failures.push(info),
      sleep: () => Promise.resolve(),
      jitter: () => 0,
      attemptTimeoutMs: 5,
    })
    const gatewayChat: GatewayDeps["chat"] = {
      joinRoom: (room, conn, userId) => chat.joinRoom(room, conn, userId),
      leaveRoom: (room, conn) => chat.leaveRoom(room, conn),
      persist: (input) => chat.persist(input),
      history: (room, before, limit, viewer, around) =>
        chat.history(room, before, limit, viewer, around),
      broadcast: () => new Promise<void>(() => undefined),
      sendResilience,
    }
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const a: GatewaySession = {
      userId: ALICE,
      conn: aConn,
      joined: new Set<string>(),
      typingThrottle: new Map<string, number>(),
      deps: { chat: gatewayChat, isMember: memberOf },
    }
    const b: GatewaySession = {
      userId: BOB,
      conn: bConn,
      joined: new Set<string>(),
      typingThrottle: new Map<string, number>(),
      deps: { chat: gatewayChat, isMember: memberOf },
    }
    await handleClientFrame(a, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(b, JSON.stringify({ type: "join", cleanupId: ROOM }))

    await handleClientFrame(a, sendFrame("c1"))
    await flush()

    expect(aConn.framesOfType("ack")).toHaveLength(1)
    expect(aConn.framesOfType("error")).toEqual([])
    expect(failures).toHaveLength(1)
    expect(failures[0]!.localRecipients).toBe(1)
    expect(bConn.framesOfType("message")).toHaveLength(1)
  })

  it("a broadcast rejection outside the adapter still cannot surface as an INTERNAL error frame", async () => {
    const h = harness()
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn, h)
    session.deps.chat = { ...h.gatewayChat, broadcast: () => Promise.reject(new Error("redis down")) }

    await expect(handleClientFrame(session, sendFrame("c1"))).resolves.toBeUndefined()
    expect(conn.framesOfType("ack")).toHaveLength(1)
    expect(conn.framesOfType("error")).toEqual([])
  })
})

describe("H17: clientId send idempotency", () => {
  it("a retry with the SAME clientId re-acks the existing id and inserts nothing", async () => {
    const h = harness({ dedupe: new InMemorySendDedupeStore() })
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn, h)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))

    await handleClientFrame(session, sendFrame("c1"))
    const first = conn.framesOfType("ack").at(-1) as { message: ChatMessageDTO }

    await handleClientFrame(session, sendFrame("c1"))
    const second = conn.framesOfType("ack").at(-1) as { clientId: string; message: ChatMessageDTO }

    expect(second.clientId).toBe("c1")
    expect(second.message.id).toBe(first.message.id)
    expect(conn.framesOfType("ack")).toHaveLength(2)
    const history = await repo.history(ROOM, undefined, 50, ALICE)
    expect(history.items).toHaveLength(1)
  })

  it("a DIFFERENT clientId inserts a second message", async () => {
    const h = harness({ dedupe: new InMemorySendDedupeStore() })
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn, h)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))

    await handleClientFrame(session, sendFrame("c1"))
    await handleClientFrame(session, sendFrame("c2"))

    const history = await repo.history(ROOM, undefined, 50, ALICE)
    expect(history.items).toHaveLength(2)
  })

  it("a failed insert releases the reservation so the retry is not swallowed", async () => {
    const store = new InMemorySendDedupeStore()
    const h = harness({ dedupe: store })
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn, h)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))

    let persistFails = true
    session.deps.chat = {
      ...h.gatewayChat,
      persist: (input) =>
        persistFails ? Promise.reject(new Error("insert failed")) : h.gatewayChat.persist(input),
    }
    await expect(handleClientFrame(session, sendFrame("c1"))).rejects.toThrow("insert failed")
    expect(store.size()).toBe(0)

    persistFails = false
    await handleClientFrame(session, sendFrame("c1"))
    const ack = conn.framesOfType("ack").at(-1) as { message: ChatMessageDTO }
    expect(ack.message.id).toBeTruthy()
    const history = await repo.history(ROOM, undefined, 50, ALICE)
    expect(history.items).toHaveLength(1)
  })

  it("an unavailable dedupe store inserts anyway (availability over dedup)", async () => {
    const open: SendDedupeStore = {
      reserve: (): Promise<SendReservation> => Promise.resolve({ state: "open" }),
      commit: () => Promise.resolve(),
      release: () => Promise.resolve(),
    }
    const h = harness({ dedupe: open })
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn, h)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))

    await handleClientFrame(session, sendFrame("c1"))
    await handleClientFrame(session, sendFrame("c1"))

    const history = await repo.history(ROOM, undefined, 50, ALICE)
    expect(history.items).toHaveLength(2)
  })

  it("a dedupe store that REJECTS never fails the send; the message is inserted", async () => {
    const broken: SendDedupeStore = {
      reserve: () => Promise.reject(new Error("redis down")),
      commit: () => Promise.reject(new Error("redis down")),
      release: () => Promise.reject(new Error("redis down")),
    }
    const h = harness({ dedupe: broken })
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn, h)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))

    await expect(handleClientFrame(session, sendFrame("c1"))).resolves.toBeUndefined()
    expect(conn.framesOfType("ack")).toHaveLength(1)
    expect(conn.framesOfType("error")).toEqual([])
    const history = await repo.history(ROOM, undefined, 50, ALICE)
    expect(history.items).toHaveLength(1)
  })

  it("a tombstoned original is re-sent rather than acked from its tombstone", async () => {
    const h = harness({ dedupe: new InMemorySendDedupeStore() })
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn, h)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))

    await handleClientFrame(session, sendFrame("c1"))
    const first = conn.framesOfType("ack").at(-1) as { message: ChatMessageDTO }
    await repo.softDelete(ROOM, first.message.id, ALICE)

    await handleClientFrame(session, sendFrame("c1"))
    const second = conn.framesOfType("ack").at(-1) as { message: ChatMessageDTO }
    expect(second.message.id).not.toBe(first.message.id)
  })

  it("commits the key after an insert that ran WITHOUT a reservation, so the next retry dedupes", async () => {
    const store = new InMemorySendDedupeStore()
    const h = harness({ dedupe: store })
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn, h)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))

    const key = sendDedupeKey(ALICE, ROOM, "c1")
    expect(await store.reserve(key)).toEqual({ state: "reserved" })

    await handleClientFrame(session, sendFrame("c1"))
    const first = conn.framesOfType("ack").at(-1) as { message: ChatMessageDTO }
    expect(first.message.id).toBeTruthy()

    expect(await store.reserve(key)).toEqual({ state: "duplicate", messageId: first.message.id })

    await handleClientFrame(session, sendFrame("c1"))
    const second = conn.framesOfType("ack").at(-1) as { message: ChatMessageDTO }
    expect(second.message.id).toBe(first.message.id)
    const history = await repo.history(ROOM, undefined, 50, ALICE)
    expect(history.items).toHaveLength(1)
  })

  it("re-points the key when a duplicate reservation names a message that is gone", async () => {
    const store = new InMemorySendDedupeStore()
    const h = harness({ dedupe: store })
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn, h)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))

    await handleClientFrame(session, sendFrame("c1"))
    const first = conn.framesOfType("ack").at(-1) as { message: ChatMessageDTO }
    await repo.softDelete(ROOM, first.message.id, ALICE)

    await handleClientFrame(session, sendFrame("c1"))
    const second = conn.framesOfType("ack").at(-1) as { message: ChatMessageDTO }
    expect(second.message.id).not.toBe(first.message.id)

    await handleClientFrame(session, sendFrame("c1"))
    const third = conn.framesOfType("ack").at(-1) as { message: ChatMessageDTO }
    expect(third.message.id).toBe(second.message.id)
    const history = await repo.history(ROOM, undefined, 50, ALICE)
    expect(history.items).toHaveLength(1)
    expect(history.items[0]!.id).toBe(second.message.id)
  })

  it("keys the reservation by user + room + clientId", () => {
    expect(sendDedupeKey(ALICE, roomKeyFor("dm", ROOM), "c1")).toBe(`chat:send:${ALICE}:dm:${ROOM}:c1`)
    expect(sendDedupeKey(ALICE, roomKeyFor("cleanup", ROOM), "c1")).toBe(`chat:send:${ALICE}:${ROOM}:c1`)
  })

  it("rejects an over-long clientId before anything is persisted", async () => {
    const h = harness({ dedupe: new InMemorySendDedupeStore() })
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn, h)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))

    await handleClientFrame(session, sendFrame("x".repeat(65)))

    const err = conn.framesOfType("error").at(-1) as { code: string }
    expect(err.code).toBe("BAD_FRAME")
    expect(conn.framesOfType("ack")).toEqual([])
    const history = await repo.history(ROOM, undefined, 50, ALICE)
    expect(history.items).toHaveLength(0)
  })
})

describe("H17: a hung Redis does not stall the per-socket frame chain", () => {
  it("reserve is bounded, commit is fire-and-forget, so a send settles on the broadcast budget", async () => {
    const hang = <T,>(): Promise<T> => new Promise<T>(() => undefined)
    const hungDedupe: SendDedupeStore = {
      reserve: () => hang<SendReservation>(),
      commit: () => hang<void>(),
      release: () => hang<void>(),
    }
    const chat = new WsChatService({ repo, pubsub: new InMemoryChatPubSub() })
    const warnings: string[] = []
    const sendResilience = makeSendResilience({
      dedupe: hungDedupe,
      deliverLocally: (roomKey, frame, excludeConnId) =>
        chat.deliverLocal(roomKey, frame, excludeConnId),
      logger: {
        warn: (_payload: unknown, msg?: string) => {
          if (msg !== undefined) warnings.push(msg)
        },
      } as unknown as Pick<FastifyBaseLogger, "warn">,
      reserveTimeoutMs: 20,
      attemptTimeoutMs: 20,
      sleep: () => Promise.resolve(),
      jitter: () => 0,
    })
    const gatewayChat: GatewayDeps["chat"] = {
      joinRoom: (room, conn, userId) => chat.joinRoom(room, conn, userId),
      leaveRoom: (room, conn) => chat.leaveRoom(room, conn),
      persist: (input) => chat.persist(input),
      history: (room, before, limit, viewer, around) =>
        chat.history(room, before, limit, viewer, around),
      broadcast: () => hang<void>(),
      sendResilience,
    }
    const conn = new MockConnection("A")
    const s: GatewaySession = {
      userId: ALICE,
      conn,
      joined: new Set<string>(),
      typingThrottle: new Map<string, number>(),
      deps: { chat: gatewayChat, isMember: memberOf },
    }
    await handleClientFrame(s, JSON.stringify({ type: "join", cleanupId: ROOM }))

    const startedAt = Date.now()
    await handleClientFrame(s, sendFrame("c1"))
    const elapsed = Date.now() - startedAt

    expect(conn.framesOfType("ack")).toHaveLength(1)
    expect(conn.framesOfType("error")).toEqual([])
    expect(sendResilience.dedupeFailureCount()).toBe(1)
    expect(warnings).toContain(
      "chat: send dedupe unavailable; the send will insert without an idempotency reservation",
    )
    expect(elapsed).toBeLessThan(20 * (BROADCAST_ATTEMPTS + 2))
    const history = await repo.history(ROOM, undefined, 50, ALICE)
    expect(history.items).toHaveLength(1)
  })

  it("rate-limits the dedupe warning so an outage cannot spam the log", () => {
    const lines: string[] = []
    let nowMs = 0
    const logger = {
      warn: (_p: unknown, m?: string) => {
        if (m !== undefined) lines.push(m)
      },
    } as unknown as Pick<FastifyBaseLogger, "warn">
    const warn = makeRateLimitedWarn(logger, 1000, () => nowMs)

    for (let i = 0; i < 50; i++) warn({ i }, "dedupe down")
    expect(lines).toHaveLength(1)

    nowMs += 1000
    warn({}, "dedupe down")
    expect(lines).toHaveLength(2)
  })
})

describe("RedisSendDedupeStore (SET NX PX)", () => {
  interface FakeRedis {
    store: Map<string, string>
    fail: boolean
    set: (...args: unknown[]) => Promise<string | null>
    get: (key: string) => Promise<string | null>
    del: (key: string) => Promise<number>
    lastSetArgs: unknown[]
  }

  function fakeRedis(): FakeRedis {
    const store = new Map<string, string>()
    const r: FakeRedis = {
      store,
      fail: false,
      lastSetArgs: [],
      set: (...args: unknown[]) => {
        if (r.fail) return Promise.reject(new Error("Command timed out"))
        r.lastSetArgs = args
        const [key, value] = args as [string, string]
        if (args.includes("NX") && store.has(key)) return Promise.resolve(null)
        store.set(key, value)
        return Promise.resolve("OK")
      },
      get: (key: string) => {
        if (r.fail) return Promise.reject(new Error("Command timed out"))
        return Promise.resolve(store.get(key) ?? null)
      },
      del: (key: string) => {
        if (r.fail) return Promise.reject(new Error("Command timed out"))
        store.delete(key)
        return Promise.resolve(1)
      },
    }
    return r
  }

  const storeFor = (r: FakeRedis) =>
    new RedisSendDedupeStore(r as unknown as RedisClient, {
      inFlightAttempts: 2,
      sleep: () => Promise.resolve(),
    })

  it("reserves pending on a SHORT NX TTL, then commits the id for 24h", async () => {
    const r = fakeRedis()
    const store = storeFor(r)
    expect(await store.reserve("k")).toEqual({ state: "reserved" })
    expect(r.lastSetArgs).toEqual(["k", "pending", "PX", 60 * 1000, "NX"])

    await store.commit("k", "msg-1")
    expect(r.lastSetArgs).toEqual(["k", "msg-1", "PX", 24 * 60 * 60 * 1000])
    expect(await store.reserve("k")).toEqual({ state: "duplicate", messageId: "msg-1" })
  })

  it("release makes the key reservable again", async () => {
    const r = fakeRedis()
    const store = storeFor(r)
    await store.reserve("k")
    await store.release("k")
    expect(await store.reserve("k")).toEqual({ state: "reserved" })
  })

  it("an in-flight reservation that never commits degrades to open, not a lost message", async () => {
    const r = fakeRedis()
    const store = storeFor(r)
    await store.reserve("k")
    expect(await store.reserve("k")).toEqual({ state: "open" })
  })

  it("every Redis failure resolves to open and never throws", async () => {
    const r = fakeRedis()
    const store = storeFor(r)
    r.fail = true
    expect(await store.reserve("k")).toEqual({ state: "open" })
    await expect(store.commit("k", "m")).resolves.toBeUndefined()
    await expect(store.release("k")).resolves.toBeUndefined()
  })
})
