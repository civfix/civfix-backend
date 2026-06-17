import { describe, it, expect, beforeEach } from "vitest"
import {
  handleClientFrame,
  roomKeyFor,
  type GatewayDeps,
  type GatewaySession,
} from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatPresence } from "../../src/adapters/chat-presence.js"
import { InMemoryChatRepository, MockConnection } from "../helpers/chat.js"
import { WsServerMessageSchema } from "@civfix/shared"

/**
 * report_discussion room routing through the WS gateway (handleClientFrame). A report discussion is a
 * PUBLIC signal room: ANY authenticated socket may JOIN to receive the live {type:"discussion"} fan-out,
 * but its WRITES go over HTTP, never the socket. This exercises authorizeRoom INDIRECTLY (it is a private
 * helper) through the public frame handler, mirroring the dm-gateway.test.ts pattern:
 *   - JOIN with roomKind:"report_discussion" succeeds with NO cleanup-membership / dm-participant gate
 *     (authorizeRoom returns ok purely on the authenticated handshake), joining the namespaced rd:<id>
 *     room and emitting a presence_snapshot carrying roomKind:"report_discussion";
 *   - SEND with roomKind:"report_discussion" is REFUSED with an UNSUPPORTED, room-scoped error frame and
 *     persists nothing (the cleanup persist branch is never reached);
 *   - every outbound frame validates against the shared server schema.
 */

const REPORT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const VIEWER = "11111111-1111-1111-1111-111111111111"

let chat: WsChatService
let pubsub: InMemoryChatPubSub
let presence: InMemoryChatPresence
let repo: InMemoryChatRepository

/**
 * A gateway session whose deps DENY every cleanup membership (isMember false) and wire NO dm seam, so a
 * successful report_discussion join can only come from authorizeRoom's public-room allowance, not a
 * membership probe.
 */
function sessionFor(userId: string, conn: MockConnection): GatewaySession {
  const deps: GatewayDeps = { chat, isMember: () => Promise.resolve(false), presence }
  return { userId, conn, joined: new Set<string>(), typingThrottle: new Map<string, number>(), deps }
}

function assertServerFrame(raw: string): void {
  const parsed = WsServerMessageSchema.safeParse(JSON.parse(raw))
  expect(parsed.success, `frame failed server schema: ${raw}`).toBe(true)
}

beforeEach(() => {
  pubsub = new InMemoryChatPubSub()
  presence = new InMemoryChatPresence()
  repo = new InMemoryChatRepository()
  chat = new WsChatService({ repo, pubsub })
})

describe("report_discussion gateway routing (public join, HTTP-only writes)", () => {
  it("authorizes a report_discussion JOIN for any authed socket (no membership gate)", async () => {
    const conn = new MockConnection("V")
    const session = sessionFor(VIEWER, conn)

    await handleClientFrame(
      session,
      JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report_discussion" }),
    )

    // It joined the NAMESPACED rd:<report> key (so report-discussion ids never collide with cleanup/dm).
    expect(session.joined.has(roomKeyFor("report_discussion", REPORT))).toBe(true)
    expect(session.joined.has(`rd:${REPORT}`)).toBe(true)
    // No error frame: the public room admitted the join despite isMember -> false and no dm seam.
    expect(conn.framesOfType("error")).toHaveLength(0)
    // The joiner got a presence_snapshot stamped with roomKind:"report_discussion" + the bare report id.
    const snaps = conn.framesOfType("presence_snapshot")
    expect(snaps).toHaveLength(1)
    expect(snaps[0]).toMatchObject({ cleanupId: REPORT, roomKind: "report_discussion" })
    for (const raw of conn.sent) assertServerFrame(raw)
  })

  it("refuses a report_discussion SEND (writes go over HTTP) and persists nothing", async () => {
    const conn = new MockConnection("V")
    const session = sessionFor(VIEWER, conn)
    await handleClientFrame(
      session,
      JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report_discussion" }),
    )

    await handleClientFrame(
      session,
      JSON.stringify({
        type: "send",
        cleanupId: REPORT,
        roomKind: "report_discussion",
        clientId: "c1",
        body: "should not persist over the socket",
      }),
    )

    // The send switch returned a single room-scoped UNSUPPORTED error frame (carrying the report id + kind).
    const errors = conn.framesOfType("error")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      code: "UNSUPPORTED",
      cleanupId: REPORT,
      roomKind: "report_discussion",
    })
    // No ack (the cleanup persist/broadcast branch was never reached) and nothing was persisted.
    expect(conn.framesOfType("ack")).toHaveLength(0)
    expect(repo.count(REPORT)).toBe(0)
    expect(repo.count(roomKeyFor("report_discussion", REPORT))).toBe(0)
    for (const raw of conn.sent) assertServerFrame(raw)
  })
})
