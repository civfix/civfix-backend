import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  handleClientFrame,
  isSocketStillAuthorized,
  type GatewaySession,
  type GatewayDeps,
} from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatPresence, RedisChatPresence } from "../../src/adapters/chat-presence.js"
import RedisMock from "ioredis-mock"
import type { RedisClient } from "../../src/adapters/redis.js"
import { InMemoryChatRepository, MockConnection } from "../helpers/chat.js"

/**
 * Security regressions for the WS gateway, from the 2026-07-24 backend review:
 *
 *   H6  — `leave` was completely unauthorized: a frame for a room the socket never joined reached
 *         presence.leave, which reported userGone from ABSENCE and so forged a presence delta into a
 *         stranger's DM/group/cleanup room.
 *   H7  — `send` passed frame.kind through, so any member could forge a `kind:"system"` platform/city
 *         timeline event.
 *   M13 — no per-connection frame throttle at all; only `send` was metered. Typing also paid for a
 *         membership query BEFORE its own throttle.
 *   M1  — a live socket was never re-authorized, so a banned/logged-out user kept full access.
 */

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
    // Bob is genuinely present in the room and holds the only live socket there.
    const bobConn = new MockConnection("bob")
    const bob = sessionFor(BOB, bobConn)
    await handleClientFrame(bob, JSON.stringify({ type: "join", cleanupId: ROOM }))
    bobConn.sent.length = 0

    // Alice never joined; she forges a leave for the same room.
    const aliceConn = new MockConnection("alice")
    const alice = sessionFor(ALICE, aliceConn)
    await handleClientFrame(alice, JSON.stringify({ type: "leave", cleanupId: ROOM }))

    // No presence delta reaches Bob, and no error frame leaks the room's existence back to Alice.
    expect(bobConn.framesOfType("presence")).toHaveLength(0)
    expect(aliceConn.sent).toHaveLength(0)
    // Bob is still shown as online: the forged leave touched nothing.
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
  // The REAL Redis adapter (against ioredis-mock) — the in-memory twin above shares the semantics but
  // not the MULTI reply parsing this fix turns on.
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
    expect((await p.leave(ROOM, "conn-2", ALICE)).userGone).toBe(false) // replayed leave: nothing removed
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

    // The bucket's capacity is 60; alternate rooms so the per-room typing throttle is not what stops us.
    for (let i = 0; i < 120; i++) {
      const room = i % 2 === 0 ? ROOM : OTHER_ROOM
      await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: room }))
    }

    const limited = conn.framesOfType("error").filter((f) => f.code === "RATE_LIMITED")
    expect(limited.length).toBeGreaterThan(0)
    // The membership lookup ran only for the frames that survived the bucket.
    expect(isMember.mock.calls.length).toBeLessThanOrEqual(70)
  })

  it("a throttled TYPING frame costs zero authorization queries (throttle runs before the gate)", async () => {
    const conn = new MockConnection("typist")
    const isMember = vi.fn(() => Promise.resolve(true))
    const session = sessionFor(ALICE, conn, { isMember })

    for (let i = 0; i < 10; i++) {
      await handleClientFrame(session, JSON.stringify({ type: "typing", cleanupId: ROOM }))
    }
    // Only the first typing frame in the TYPING_MIN_INTERVAL_MS window reaches authorizeRoom.
    expect(isMember).toHaveBeenCalledTimes(1)
  })
})

describe("M1: a live socket is re-authorized, not trusted forever", () => {
  const sessions = (over: Record<string, unknown>): Parameters<typeof isSocketStillAuthorized>[0] =>
    over as unknown as Parameters<typeof isSocketStillAuthorized>[0]

  it("closes on a banned account (isUserActive false), on the cheap every-tick check", async () => {
    const svc = sessions({
      isUserActive: () => Promise.resolve(false),
      resolveSession: () => Promise.reject(new Error("must not be reached")),
    })
    expect(await isSocketStillAuthorized(svc, ALICE, "tok", false)).toBe(false)
  })

  it("closes when the session was revoked (full re-resolve returns null)", async () => {
    const svc = sessions({
      isUserActive: () => Promise.resolve(true),
      resolveSession: () => Promise.resolve(null),
    })
    expect(await isSocketStillAuthorized(svc, ALICE, "tok", true)).toBe(false)
    // The full re-resolve is throttled: with fullCheck=false the same socket survives the tick.
    expect(await isSocketStillAuthorized(svc, ALICE, "tok", false)).toBe(true)
  })

  it("closes when the token now resolves to a DIFFERENT user", async () => {
    const svc = sessions({
      isUserActive: () => Promise.resolve(true),
      resolveSession: () => Promise.resolve({ userId: BOB, roles: [] }),
    })
    expect(await isSocketStillAuthorized(svc, ALICE, "tok", true)).toBe(false)
  })

  it("keeps a valid session, and skips the resolve entirely on the ticket path (no token)", async () => {
    const resolveSession = vi.fn(() => Promise.resolve({ userId: ALICE, roles: [] }))
    const svc = sessions({ isUserActive: () => Promise.resolve(true), resolveSession })
    expect(await isSocketStillAuthorized(svc, ALICE, "tok", true)).toBe(true)
    expect(await isSocketStillAuthorized(svc, ALICE, undefined, true)).toBe(true)
    expect(resolveSession).toHaveBeenCalledTimes(1)
  })

  it("FAILS OPEN on an infrastructure error (a Redis blip must not disconnect every socket)", async () => {
    const svc = sessions({ isUserActive: () => Promise.reject(new Error("redis down")) })
    expect(await isSocketStillAuthorized(svc, ALICE, "tok", true)).toBe(true)
  })
})
