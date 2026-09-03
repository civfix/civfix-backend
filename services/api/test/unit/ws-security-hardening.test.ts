import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  handleClientFrame,
  isSocketStillAuthorized,
  checkSocketAuthorization,
  canStillRead,
  reauthorizeJoinedRooms,
  roomKeyFor,
  WS_MAX_JOINED_ROOMS,
  type GatewaySession,
  type GatewayDeps,
} from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatPresence, RedisChatPresence } from "../../src/adapters/chat-presence.js"
import RedisMock from "ioredis-mock"
import type { RedisClient } from "../../src/adapters/redis.js"
import { InMemoryChatRepository, MockConnection } from "../helpers/chat.js"


const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const OTHER_ROOM = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"

const allMembers = (): Promise<boolean> => Promise.resolve(true)

let chat: WsChatService
let presence: InMemoryChatPresence

function sessionFor(userId: string, conn: MockConnection, over: Partial<GatewayDeps> = {}): GatewaySession {
  const deps: GatewayDeps = { chat, isMember: allMembers, presence, ...over }
  return { userId, conn, joined: new Set<string>(), typingThrottle: new Map<string, number>(), deps }
}

beforeEach(() => {
  presence = new InMemoryChatPresence()
  chat = new WsChatService({ repo: new InMemoryChatRepository(), pubsub: new InMemoryChatPubSub() })
})

describe("H6: the leave frame is gated on what THIS socket joined", () => {
  it("a leave for a room the socket never joined is a silent no-op (no presence write, no broadcast)", async () => {
    const bobConn = new MockConnection("bob")
    const bob = sessionFor(BOB, bobConn)
    await handleClientFrame(bob, JSON.stringify({ type: "join", cleanupId: ROOM }))
    bobConn.sent.length = 0

    const aliceConn = new MockConnection("alice")
    const alice = sessionFor(ALICE, aliceConn)
    await handleClientFrame(alice, JSON.stringify({ type: "leave", cleanupId: ROOM }))

    expect(bobConn.framesOfType("presence")).toHaveLength(0)
    expect(aliceConn.sent).toHaveLength(0)
    expect(await presence.online(ROOM)).toEqual([BOB])
  })

  it("a forged leave for a DM room the socket never joined announces nothing", async () => {
    const victimConn = new MockConnection("victim")
    const victim = sessionFor(BOB, victimConn, {
      dm: {
        peerOf: () => Promise.resolve(ALICE),
        persist: () => Promise.reject(new Error("unused")),
        markRead: () => Promise.resolve(),
      },
    })
    await handleClientFrame(victim, JSON.stringify({ type: "join", roomKind: "dm", cleanupId: ROOM }))
    victimConn.sent.length = 0

    const attackerConn = new MockConnection("attacker")
    const attacker = sessionFor(ALICE, attackerConn)
    await handleClientFrame(
      attacker,
      JSON.stringify({ type: "leave", roomKind: "dm", cleanupId: ROOM }),
    )

    expect(victimConn.framesOfType("presence")).toHaveLength(0)
    expect(await presence.online(`dm:${ROOM}`)).toEqual([BOB])
  })

  it("a leave for a room the socket DID join still works (join -> leave delta to the others)", async () => {
    const aConn = new MockConnection("a")
    const bConn = new MockConnection("b")
    const a = sessionFor(ALICE, aConn)
    const b = sessionFor(BOB, bConn)
    await handleClientFrame(a, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(b, JSON.stringify({ type: "join", cleanupId: ROOM }))
    bConn.sent.length = 0

    await handleClientFrame(a, JSON.stringify({ type: "leave", cleanupId: ROOM }))

    const deltas = bConn.framesOfType("presence")
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ userId: ALICE, state: "leave" })
    expect(a.joined.has(ROOM)).toBe(false)
    expect(await presence.online(ROOM)).toEqual([BOB])
  })
})

describe("H6: presence.leave only reports userGone when it actually removed the connection", () => {
  it("a leave for a connection that was never present reports userGone:false", async () => {
    await presence.join(ROOM, "conn-bob", BOB)
    const result = await presence.leave(ROOM, "conn-nobody", ALICE)
    expect(result.userGone).toBe(false)
    expect(result.online).toEqual([BOB])
  })

  it("a DOUBLE leave for the same connection reports userGone only once", async () => {
    await presence.join(ROOM, "conn-1", ALICE)
    expect((await presence.leave(ROOM, "conn-1", ALICE)).userGone).toBe(true)
    expect((await presence.leave(ROOM, "conn-1", ALICE)).userGone).toBe(false)
  })
})

describe("H6: RedisChatPresence.leave reads the ZREM's own reply slot", () => {
  const makeRedis = (): RedisClient => new RedisMock() as unknown as RedisClient

  it("reports userGone:false for a connection that was never in the sorted set", async () => {
    const redis = makeRedis()
    const p = new RedisChatPresence(redis)
    await p.join(ROOM, "conn-bob", BOB)
    const result = await p.leave(ROOM, "conn-nobody", ALICE)
    expect(result.userGone).toBe(false)
    expect(result.online).toEqual([BOB])
  })

  it("still reports userGone:true when the user's last real connection leaves", async () => {
    const redis = makeRedis()
    const p = new RedisChatPresence(redis)
    await p.join(ROOM, "conn-1", ALICE)
    await p.join(ROOM, "conn-2", ALICE)
    expect((await p.leave(ROOM, "conn-1", ALICE)).userGone).toBe(false)
    expect((await p.leave(ROOM, "conn-2", ALICE)).userGone).toBe(true)
    expect((await p.leave(ROOM, "conn-2", ALICE)).userGone).toBe(false)
  })
})

describe("H7: only client-authorable message kinds are accepted on send", () => {
  const sendFrame = (kind?: string): string =>
    JSON.stringify({
      type: "send",
      cleanupId: ROOM,
      body: "Status updated to Resolved by the City of Los Angeles.",
      clientId: "c1",
      ...(kind !== undefined ? { kind } : {}),
    })

  it("rejects kind:'system' with BAD_FRAME and persists nothing", async () => {
    const conn = new MockConnection("a")
    const persist = vi.fn()
    const session = sessionFor(ALICE, conn, {
      chat: { ...chat, persist } as unknown as GatewayDeps["chat"],
    })
    await handleClientFrame(session, sendFrame("system"))

    const errors = conn.framesOfType("error")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: "BAD_FRAME" })
    expect(persist).not.toHaveBeenCalled()
    expect(conn.framesOfType("ack")).toHaveLength(0)
  })

  it("rejects kind:'poll' too (poll rows are created by the poll routes)", async () => {
    const conn = new MockConnection("a")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, sendFrame("poll"))
    expect(conn.framesOfType("error")[0]).toMatchObject({ code: "BAD_FRAME" })
  })

  it("accepts the client-authorable kinds and the default (no kind)", async () => {
    for (const kind of [undefined, "text", "share_pin", "task_complete", "rsvp_change"]) {
      const conn = new MockConnection(`a-${kind ?? "default"}`)
      const session = sessionFor(ALICE, conn)
      await handleClientFrame(session, sendFrame(kind))
      expect(conn.framesOfType("error")).toHaveLength(0)
      expect(conn.framesOfType("ack")).toHaveLength(1)
    }
  })
})

describe("M13: per-connection frame throttle covering ALL frame types", () => {
  it("throttles a join/typing flood with RATE_LIMITED instead of paying for a query each time", async () => {
    const conn = new MockConnection("flood")
    const isMember = vi.fn(() => Promise.resolve(true))
    const session = sessionFor(ALICE, conn, { isMember })

    for (let i = 0; i < 120; i++) {
      const room = i % 2 === 0 ? ROOM : OTHER_ROOM
      await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: room }))
    }

    const limited = conn.framesOfType("error").filter((f) => f.code === "RATE_LIMITED")
    expect(limited.length).toBeGreaterThan(0)
    expect(isMember.mock.calls.length).toBeLessThanOrEqual(70)
  })

  it("a throttled TYPING frame costs zero authorization queries (throttle runs before the gate)", async () => {
    const conn = new MockConnection("typist")
    const isMember = vi.fn(() => Promise.resolve(true))
    const session = sessionFor(ALICE, conn, { isMember })

    for (let i = 0; i < 10; i++) {
      await handleClientFrame(session, JSON.stringify({ type: "typing", cleanupId: ROOM }))
    }
    expect(isMember).toHaveBeenCalledTimes(1)
  })
})

describe("M1: a live socket is re-authorized, not trusted forever", () => {
  const sessions = (over: Record<string, unknown>): Parameters<typeof isSocketStillAuthorized>[0] =>
    over as unknown as Parameters<typeof isSocketStillAuthorized>[0]

  it("closes on a banned account (isUserActive false), on the cheap every-tick check", async () => {
    const svc = sessions({
      isUserActive: () => Promise.resolve(false),
      resolveSessionByHash: () => Promise.reject(new Error("must not be reached")),
    })
    expect(await isSocketStillAuthorized(svc, ALICE, "hash", false)).toBe(false)
  })

  it("closes when the session was revoked (full re-resolve returns null)", async () => {
    const svc = sessions({
      isUserActive: () => Promise.resolve(true),
      resolveSessionByHash: () => Promise.resolve(null),
    })
    expect(await isSocketStillAuthorized(svc, ALICE, "hash", true)).toBe(false)
    expect(await isSocketStillAuthorized(svc, ALICE, "hash", false)).toBe(true)
  })

  it("closes when the session hash now resolves to a DIFFERENT user", async () => {
    const svc = sessions({
      isUserActive: () => Promise.resolve(true),
      resolveSessionByHash: () => Promise.resolve({ userId: BOB, roles: [] }),
    })
    expect(await isSocketStillAuthorized(svc, ALICE, "hash", true)).toBe(false)
  })

  it("H2: the TICKET path is re-resolved too (a ticket carries the hash of the session that minted it)", async () => {
    const resolveSessionByHash = vi.fn(() =>
      Promise.resolve({ userId: ALICE, roles: [], accountStatus: "active" }),
    )
    const svc = sessions({ isUserActive: () => Promise.resolve(true), resolveSessionByHash })
    expect(await isSocketStillAuthorized(svc, ALICE, "ticket-hash", true)).toBe(true)
    expect(resolveSessionByHash).toHaveBeenCalledWith("ticket-hash")
    // Only a socket with NO session hash at all (a legacy ticket in flight across a deploy) degrades to
    // the cheap banned-marker check.
    expect(await isSocketStillAuthorized(svc, ALICE, undefined, true)).toBe(true)
    expect(resolveSessionByHash).toHaveBeenCalledTimes(1)
  })

  it("H4: a full re-check surfaces the account status so the frame handler can deny writes", async () => {
    const svc = sessions({
      isUserActive: () => Promise.resolve(true),
      resolveSessionByHash: () =>
        Promise.resolve({ userId: ALICE, roles: [], accountStatus: "suspended" }),
    })
    expect(await checkSocketAuthorization(svc, ALICE, "hash", true)).toEqual({
      authorized: true,
      accountStatus: "suspended",
    })
  })

  it("FAILS OPEN on an infrastructure error (a Redis blip must not disconnect every socket)", async () => {
    const svc = sessions({ isUserActive: () => Promise.reject(new Error("redis down")) })
    expect(await isSocketStillAuthorized(svc, ALICE, "hash", true)).toBe(true)
  })
})

describe("F036: repeat join is idempotent (no duplicate presence delta, no re-run of joinRoom)", () => {
  it("a second join for a room already held re-sends only presence_snapshot", async () => {
    const bobConn = new MockConnection("bob")
    const bob = sessionFor(BOB, bobConn)
    await handleClientFrame(bob, JSON.stringify({ type: "join", cleanupId: ROOM }))

    const aliceConn = new MockConnection("alice")
    const alice = sessionFor(ALICE, aliceConn)
    await handleClientFrame(alice, JSON.stringify({ type: "join", cleanupId: ROOM }))
    bobConn.sent.length = 0
    aliceConn.sent.length = 0

    await handleClientFrame(alice, JSON.stringify({ type: "join", cleanupId: ROOM }))

    expect(bobConn.framesOfType("presence")).toHaveLength(0)
    expect(aliceConn.framesOfType("presence_snapshot")).toHaveLength(1)
    expect(aliceConn.framesOfType("presence")).toHaveLength(0)
    expect((await presence.online(ROOM)).sort()).toEqual([ALICE, BOB].sort())
    expect(chat.roomSize(ROOM)).toBe(2)
  })
})

describe("F037: an over-long clientId is rejected, never persisted or fanned out", () => {
  it("a send with a >64-char clientId is answered BAD_FRAME and persists nothing", async () => {
    const conn = new MockConnection("a")
    const persist = vi.fn()
    const session = sessionFor(ALICE, conn, {
      chat: { ...chat, persist } as unknown as GatewayDeps["chat"],
    })
    await handleClientFrame(
      session,
      JSON.stringify({ type: "send", cleanupId: ROOM, body: "hi", clientId: "x".repeat(65) }),
    )
    expect(conn.framesOfType("error")[0]).toMatchObject({ code: "BAD_FRAME" })
    expect(persist).not.toHaveBeenCalled()
    expect(conn.framesOfType("ack")).toHaveLength(0)
  })

  it("a send with a 64-char clientId is accepted (the bound is not off-by-one)", async () => {
    const conn = new MockConnection("a")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(
      session,
      JSON.stringify({ type: "send", cleanupId: ROOM, body: "hi", clientId: "x".repeat(64) }),
    )
    expect(conn.framesOfType("error")).toHaveLength(0)
    expect(conn.framesOfType("ack")).toHaveLength(1)
  })
})

describe("F039: a socket cannot join more than WS_MAX_JOINED_ROOMS rooms", () => {
  it("the cap+1-th distinct room is refused RATE_LIMITED, and does not run joinRoom", async () => {
    const conn = new MockConnection("a")
    const joinRoom = vi.fn(() => Promise.resolve())
    const session = sessionFor(ALICE, conn, {
      chat: { ...chat, joinRoom } as unknown as GatewayDeps["chat"],
      presence: undefined,
    })
    for (let i = 0; i < WS_MAX_JOINED_ROOMS; i++) {
      session.joined.add(roomKeyFor("cleanup", `room-${i}`))
    }
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: OTHER_ROOM }))
    expect(conn.framesOfType("error")[0]).toMatchObject({ code: "RATE_LIMITED" })
    expect(joinRoom).not.toHaveBeenCalled()
    expect(session.joined.has(roomKeyFor("cleanup", OTHER_ROOM))).toBe(false)
  })

  it("re-joining a room already held is allowed even at the cap (the idempotent path precedes it)", async () => {
    const conn = new MockConnection("a")
    const session = sessionFor(ALICE, conn, { presence: undefined })
    for (let i = 0; i < WS_MAX_JOINED_ROOMS - 1; i++) {
      session.joined.add(roomKeyFor("cleanup", `room-${i}`))
    }
    session.joined.add(roomKeyFor("cleanup", ROOM))
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))
    expect(conn.framesOfType("error")).toHaveLength(0)
  })
})

describe("F041: ack does nothing for a room the socket never joined", () => {
  const UP_TO = "00000000-0000-0000-0000-000000000001"

  it("a cleanup ack for an unjoined room runs no read-watermark write", async () => {
    const conn = new MockConnection("a")
    const markRead = vi.fn(() => Promise.resolve())
    const session = sessionFor(ALICE, conn, { markRead })
    await handleClientFrame(session, JSON.stringify({ type: "ack", cleanupId: ROOM, upToId: UP_TO }))
    expect(markRead).not.toHaveBeenCalled()
  })

  it("once the room is joined the ack advances the watermark", async () => {
    const conn = new MockConnection("a")
    const markRead = vi.fn(() => Promise.resolve())
    const session = sessionFor(ALICE, conn, { markRead })
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(session, JSON.stringify({ type: "ack", cleanupId: ROOM, upToId: UP_TO }))
    expect(markRead).toHaveBeenCalledTimes(1)
  })
})

describe("F022: live sockets are re-authorized against room membership", () => {
  it("canStillRead tracks membership, and fails OPEN on a thrown check", async () => {
    const conn = new MockConnection("a")
    let member = true
    const session = sessionFor(ALICE, conn, { isMember: () => Promise.resolve(member) })
    const key = roomKeyFor("cleanup", ROOM)
    session.joined.add(key)
    expect(await canStillRead(session, key)).toBe(true)
    member = false
    expect(await canStillRead(session, key)).toBe(false)
    const throwing = sessionFor(ALICE, conn, { isMember: () => Promise.reject(new Error("redis down")) })
    expect(await canStillRead(throwing, key)).toBe(true)
  })

  it("reauthorizeJoinedRooms evicts a revoked member's socket and announces the leave", async () => {
    let aliceMember = true
    const isMember = (_cleanupId: string, userId: string): Promise<boolean> =>
      Promise.resolve(userId === ALICE ? aliceMember : true)

    const bobConn = new MockConnection("bob")
    const bob = sessionFor(BOB, bobConn, { isMember })
    await handleClientFrame(bob, JSON.stringify({ type: "join", cleanupId: ROOM }))

    const aliceConn = new MockConnection("alice")
    const alice = sessionFor(ALICE, aliceConn, { isMember })
    await handleClientFrame(alice, JSON.stringify({ type: "join", cleanupId: ROOM }))
    bobConn.sent.length = 0
    aliceConn.sent.length = 0

    aliceMember = false
    await reauthorizeJoinedRooms(alice)

    expect(aliceConn.framesOfType("error")[0]).toMatchObject({ code: "FORBIDDEN" })
    expect(alice.joined.has(roomKeyFor("cleanup", ROOM))).toBe(false)
    expect(bobConn.framesOfType("presence")[0]).toMatchObject({ userId: ALICE, state: "leave" })
    expect(await presence.online(ROOM)).toEqual([BOB])
  })

  it("keeps the socket (fail-open) when the reauth membership check throws", async () => {
    const conn = new MockConnection("a")
    let mode: "ok" | "throw" = "ok"
    const session = sessionFor(ALICE, conn, {
      isMember: () =>
        mode === "throw" ? Promise.reject(new Error("redis down")) : Promise.resolve(true),
    })
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))
    conn.sent.length = 0
    mode = "throw"
    await reauthorizeJoinedRooms(session)
    expect(conn.framesOfType("error")).toHaveLength(0)
    expect(session.joined.has(roomKeyFor("cleanup", ROOM))).toBe(true)
  })
})

describe("H4: a suspended account is read-only on the socket", () => {
  it("denies a send frame with a FORBIDDEN error frame and persists nothing", async () => {
    const conn = new MockConnection("alice")
    const session = sessionFor(ALICE, conn)
    session.accountStatus = "suspended"

    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))
    conn.sent.length = 0
    await handleClientFrame(
      session,
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c1", body: "hello" }),
    )

    const errors = conn.framesOfType("error")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: "FORBIDDEN" })
    expect(conn.framesOfType("message")).toHaveLength(0)
  })

  it("still allows join, typing and ack (reads stay open so the user can see the notice)", async () => {
    const conn = new MockConnection("alice")
    const session = sessionFor(ALICE, conn, { markRead: () => Promise.resolve() })
    session.accountStatus = "suspended"

    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))
    expect(conn.framesOfType("presence_snapshot")).toHaveLength(1)
    conn.sent.length = 0

    await handleClientFrame(session, JSON.stringify({ type: "typing", cleanupId: ROOM }))
    await handleClientFrame(
      session,
      JSON.stringify({ type: "ack", cleanupId: ROOM, upToId: "00000000-0000-0000-0000-000000000001" }),
    )
    expect(conn.framesOfType("error")).toHaveLength(0)
  })

  it("an ACTIVE account is unaffected", async () => {
    const conn = new MockConnection("alice")
    const session = sessionFor(ALICE, conn)
    session.accountStatus = "active"
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: ROOM }))
    conn.sent.length = 0
    await handleClientFrame(
      session,
      JSON.stringify({ type: "send", cleanupId: ROOM, clientId: "c1", body: "hello" }),
    )
    expect(conn.framesOfType("error")).toHaveLength(0)
  })
})
