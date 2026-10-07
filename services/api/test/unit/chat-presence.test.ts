import { describe, it, expect, beforeEach } from "vitest"
import { handleClientFrame, type GatewaySession, type GatewayDeps } from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatPresence, PRESENCE_TTL_MS } from "../../src/adapters/chat-presence.js"
import { InMemoryChatRepository, MockConnection } from "../helpers/chat.js"

/**
 * Live presence: the registry bookkeeping (who is online, multi-device dedupe, TTL self-heal) AND the
 * gateway flow it drives (a presence_snapshot to the joiner + presence join/leave DELTAS to the others,
 * one per user transition - opening a second device does not re-announce).
 */

const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ALICE = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"

const allMembers = (_c: string, _u: string): Promise<boolean> => Promise.resolve(true)

let chat: WsChatService
let pubsub: InMemoryChatPubSub
let repo: InMemoryChatRepository
let presence: InMemoryChatPresence

function sessionFor(userId: string, conn: MockConnection): GatewaySession {
  const deps: GatewayDeps = { chat, isMember: allMembers, presence }
  return {
    userId,
    conn,
    joined: new Set<string>(),
    typingThrottle: new Map<string, number>(),
    deps,
  }
}

beforeEach(() => {
  pubsub = new InMemoryChatPubSub()
  repo = new InMemoryChatRepository()
  presence = new InMemoryChatPresence()
  chat = new WsChatService({ repo, pubsub })
})

describe("InMemoryChatPresence registry", () => {
  it("dedupes a user's devices and reports userJoined only on the first connection", async () => {
    const r1 = await presence.join(ROOM, "conn-1", ALICE)
    expect(r1.online).toEqual([ALICE])
    expect(r1.userJoined).toBe(true)

    // Second device for the same user: still one online user, NOT a new join.
    const r2 = await presence.join(ROOM, "conn-2", ALICE)
    expect(r2.online).toEqual([ALICE])
    expect(r2.userJoined).toBe(false)

    // A different user IS a new join; online is sorted + deduped.
    const r3 = await presence.join(ROOM, "conn-3", BOB)
    expect(r3.online).toEqual([ALICE, BOB].sort())
    expect(r3.userJoined).toBe(true)
  })

  it("reports userGone only when a user's LAST connection leaves", async () => {
    await presence.join(ROOM, "conn-1", ALICE)
    await presence.join(ROOM, "conn-2", ALICE)
    await presence.join(ROOM, "conn-3", BOB)

    const l1 = await presence.leave(ROOM, "conn-1", ALICE)
    expect(l1.userGone).toBe(false) // Alice still has conn-2
    expect(l1.online).toEqual([ALICE, BOB].sort())

    const l2 = await presence.leave(ROOM, "conn-2", ALICE)
    expect(l2.userGone).toBe(true) // Alice's last connection left
    expect(l2.online).toEqual([BOB])
  })

  it("self-heals: a connection that stops being refreshed is pruned after the TTL", async () => {
    let now = 1_000_000
    const clock = new InMemoryChatPresence(() => now)
    await clock.join(ROOM, "conn-1", ALICE)
    await clock.join(ROOM, "conn-2", BOB)
    expect(await clock.online(ROOM)).toEqual([ALICE, BOB].sort())

    // Advance past the TTL but keep Bob alive with a refresh; Alice (never refreshed) is pruned.
    now += PRESENCE_TTL_MS + 1
    await clock.refresh(ROOM, "conn-2", BOB)
    expect(await clock.online(ROOM)).toEqual([BOB])
  })
})

describe("gateway presence flow (snapshot to joiner, deltas to others)", () => {
  it("sends a snapshot on join and a join delta to the OTHER members only", async () => {
    const aConn = new MockConnection("A")
    const bConn = new MockConnection("B")
    const aSession = sessionFor(ALICE, aConn)
    const bSession = sessionFor(BOB, bConn)

    await handleClientFrame(aSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    // A joined alone: a snapshot of just itself, and NO join delta to itself.
    expect(aConn.framesOfType("presence_snapshot")).toHaveLength(1)
    expect((aConn.framesOfType("presence_snapshot")[0] as { userIds: string[] }).userIds).toEqual([
      ALICE,
    ])
    expect(aConn.framesOfType("presence")).toHaveLength(0)

    await handleClientFrame(bSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    // B's snapshot lists both; A gets a presence(join) delta for B; B gets no delta about itself.
    expect(
      (bConn.framesOfType("presence_snapshot")[0] as { userIds: string[] }).userIds.sort(),
    ).toEqual([ALICE, BOB].sort())
    const aDeltas = aConn.framesOfType("presence")
    expect(aDeltas).toHaveLength(1)
    expect(aDeltas[0]).toMatchObject({
      type: "presence",
      userId: BOB,
      state: "join",
      cleanupId: ROOM,
    })
    expect(bConn.framesOfType("presence")).toHaveLength(0)
  })

  it("a user's second device does NOT re-announce a join to others", async () => {
    const bConn = new MockConnection("B")
    const a1 = new MockConnection("A1")
    const a2 = new MockConnection("A2")
    const bSession = sessionFor(BOB, bConn)
    const a1Session = sessionFor(ALICE, a1)
    const a2Session = sessionFor(ALICE, a2)

    await handleClientFrame(bSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(a1Session, JSON.stringify({ type: "join", cleanupId: ROOM }))
    expect(bConn.framesOfType("presence").filter((f) => f.userId === ALICE)).toHaveLength(1)

    // Alice opens a second device: B must NOT see another "join" for Alice (she was already online).
    await handleClientFrame(a2Session, JSON.stringify({ type: "join", cleanupId: ROOM }))
    expect(bConn.framesOfType("presence").filter((f) => f.userId === ALICE)).toHaveLength(1)
  })

  it("broadcasts a leave delta only when a user's LAST device leaves", async () => {
    const bConn = new MockConnection("B")
    const a1 = new MockConnection("A1")
    const a2 = new MockConnection("A2")
    const bSession = sessionFor(BOB, bConn)
    const a1Session = sessionFor(ALICE, a1)
    const a2Session = sessionFor(ALICE, a2)

    await handleClientFrame(bSession, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(a1Session, JSON.stringify({ type: "join", cleanupId: ROOM }))
    await handleClientFrame(a2Session, JSON.stringify({ type: "join", cleanupId: ROOM }))

    const leaveDeltasBefore = bConn
      .framesOfType("presence")
      .filter((f) => f.state === "leave").length

    // Alice's first device leaves: she still has a2, so NO leave delta.
    await handleClientFrame(a1Session, JSON.stringify({ type: "leave", cleanupId: ROOM }))
    expect(bConn.framesOfType("presence").filter((f) => f.state === "leave")).toHaveLength(
      leaveDeltasBefore,
    )

    // Alice's last device leaves: now B sees the leave delta for Alice.
    await handleClientFrame(a2Session, JSON.stringify({ type: "leave", cleanupId: ROOM }))
    const leaveForAlice = bConn
      .framesOfType("presence")
      .filter((f) => f.state === "leave" && f.userId === ALICE)
    expect(leaveForAlice).toHaveLength(1)
  })
})
