import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import {
  handleClientFrame,
  type GatewayDeps,
  type GatewayReportChat,
  type GatewaySession,
  type OnReportMessage,
} from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatPresence } from "../../src/adapters/chat-presence.js"
import { InMemoryChatRepository, InMemoryThreadsRepository, MockConnection } from "../helpers/chat.js"
import { forwardReportCityMention } from "../../src/services/report-city-forward.js"
import { makeTokenBucketLimiter, type RateLimiter } from "../../src/ws/report-rate-limit.js"
import type {
  OutboundMailService,
  SendReportInput,
} from "../../src/services/admin/outbound-mail-service.js"
import type { MailThreadRecord } from "../../src/services/admin/mail-repository.drizzle.js"
import type { ReportJurisdictionView } from "../../src/services/discussion-types.js"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { FakeMailer } from "@civfix/shared/fakes"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryBlocksRepository, InMemoryDmRepository } from "../../src/services/dm-repository.memory.js"
import { InMemoryDiscussionRepository } from "../helpers/discussion.js"


const REPORT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const HELD_REPORT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const CLEANUP = "cccccccc-cccc-cccc-cccc-cccccccccccc"
const ALICE = "11111111-1111-1111-1111-111111111111"

const SF_JURISDICTION: ReportJurisdictionView = {
  geoid: "0600001",
  name: "City of San Francisco",
  handle: "sf",
  contactEmail: "fix@sf.gov",
}

class SpyOutboundMail implements OutboundMailService {
  readonly reportCalls: SendReportInput[] = []
  sendReportToJurisdiction(
    input: SendReportInput,
  ): Promise<{ thread: MailThreadRecord; messageId: string }> {
    this.reportCalls.push(input)
    return Promise.resolve({ thread: stubThread(), messageId: "<stub@civfix.org>" })
  }
  sendEventToJurisdiction(): Promise<{ thread: MailThreadRecord; messageId: string }> {
    return Promise.resolve({ thread: stubThread(), messageId: "<stub@civfix.org>" })
  }
  sendToCity(): Promise<MailThreadRecord> {
    return Promise.resolve(stubThread())
  }
  compose(): Promise<MailThreadRecord> {
    return Promise.resolve(stubThread())
  }
  appendOutbound(): Promise<MailThreadRecord> {
    return Promise.resolve(stubThread())
  }
}

function stubThread(): MailThreadRecord {
  return {
    id: "thread-1",
    threadToken: "geo-1",
    reportId: null,
    cleanupId: null,
    jurisdictionGeoid: null,
    org: null,
    subject: null,
    status: "sent",
    unread: false,
    lastMessageAt: null,
    createdAt: new Date(),
  }
}

let chat: WsChatService
let chatRepo: InMemoryChatRepository
let presence: InMemoryChatPresence
let mail: SpyOutboundMail
let visibleReports: Set<string>
let sendLimiter: RateLimiter | undefined
let cityForwardSeen: Map<string, number>
// Membership repo fake (D-C3): report rooms are member-only to post/type; ack advances a watermark.
// When left undefined, deps.reportChat is omitted and the send/typing gate FAILS CLOSED (the group
// lane's stance): with no membership source there is nothing to authorize a post against.
let reportChat: GatewayReportChat | undefined

/** GatewayReportChat fake: `isMember` drives the member-only send/typing gate; the ack write is spied. */
function makeReportChat(
  isMember: boolean,
): GatewayReportChat & { advanceReadWatermark: ReturnType<typeof vi.fn> } {
  return {
    isMember: () => Promise.resolve(isMember),
    advanceReadWatermark: vi.fn(() => Promise.resolve()),
  }
}

function canForwardCity(reportId: string, geoid: string): boolean {
  const key = `${reportId}:${geoid}`
  const t = Date.now()
  const until = cityForwardSeen.get(key)
  if (until !== undefined && until > t) return false
  cityForwardSeen.set(key, t + 10 * 60 * 1000)
  return true
}

const onReportMessage: OnReportMessage = async (reportId, message) => {
  const body = typeof message.body === "string" ? message.body : ""
  await forwardReportCityMention(
    mail,
    { reportId, category: "graffiti", place: "SF", jurisdiction: SF_JURISDICTION },
    body,
    new Date(message.createdAt),
    { canForward: canForwardCity },
  )
}

function sessionFor(userId: string, conn: MockConnection): GatewaySession {
  const deps: GatewayDeps = {
    chat,
    isMember: () => Promise.resolve(false),
    presence,
    onReportMessage,
    reportVisible: (reportId: string) => Promise.resolve(visibleReports.has(reportId)),
    ...(sendLimiter ? { reportSendLimiter: sendLimiter } : {}),
    ...(reportChat ? { reportChat } : {}),
  }
  return { userId, conn, joined: new Set<string>(), typingThrottle: new Map<string, number>(), deps }
}

beforeEach(() => {
  presence = new InMemoryChatPresence()
  chatRepo = new InMemoryChatRepository()
  chatRepo.registerSender({ id: ALICE, displayName: "Alice", handle: "alice", bio: null })
  chat = new WsChatService({ repo: chatRepo, pubsub: new InMemoryChatPubSub() })
  mail = new SpyOutboundMail()
  visibleReports = new Set<string>([REPORT])
  sendLimiter = undefined
  cityForwardSeen = new Map<string, number>()
  reportChat = undefined
})

describe("report chat gateway", () => {
  it("authorizes a report JOIN with no membership (public-read/join)", async () => {
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report" }))

    expect(conn.framesOfType("error")).toHaveLength(0)
    expect(conn.framesOfType("presence_snapshot")).toHaveLength(1)
    expect(session.joined.has(`report:${REPORT}`)).toBe(true)
  })

  it("STILL refuses a cleanup JOIN from a non-member (report's public gate did not weaken cleanup)", async () => {
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: CLEANUP }))

    const errors = conn.framesOfType("error")
    expect(errors).toHaveLength(1)
    expect((errors[0] as { code: string }).code).toBe("FORBIDDEN")
    expect(session.joined.has(CLEANUP)).toBe(false)
  })

  it("persists an authed report SEND as a report-scoped message (roomKind report, report_id routed)", async () => {
    reportChat = makeReportChat(true)
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report" }))
    await handleClientFrame(
      session,
      JSON.stringify({ type: "send", cleanupId: REPORT, roomKind: "report", clientId: "c1", body: "hello" }),
    )

    const acks = conn.framesOfType("ack")
    expect(acks).toHaveLength(1)
    const message = (acks[0] as { message: { roomKind?: string; cleanupId: string } }).message
    expect(message.roomKind).toBe("report")
    expect(message.cleanupId).toBe(REPORT)
    expect(chatRepo.count(REPORT)).toBe(1)
  })

  it("refuses WS JOIN and SEND for a non-visible (held) report and persists nothing", async () => {
    // A MEMBER fake, so the only possible reason for the refusal below is visibility.
    reportChat = makeReportChat(true)
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: HELD_REPORT, roomKind: "report" }))
    await handleClientFrame(
      session,
      JSON.stringify({ type: "send", cleanupId: HELD_REPORT, roomKind: "report", clientId: "c1", body: "leak?" }),
    )

    const errors = conn.framesOfType("error")
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors.every((e) => (e as { code: string }).code === "NOT_FOUND")).toBe(true)
    expect(session.joined.has(`report:${HELD_REPORT}`)).toBe(false)
    expect(conn.framesOfType("ack")).toHaveLength(0)
    expect(chatRepo.count(HELD_REPORT)).toBe(0)
  })

  it("rate-limits the report send path per user+report (over-limit send refused, not persisted)", async () => {
    reportChat = makeReportChat(true)
    sendLimiter = makeTokenBucketLimiter({ capacity: 2, refillPerSec: 0 })
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report" }))
    for (const body of ["m1", "m2", "m3"]) {
      await handleClientFrame(
        session,
        JSON.stringify({ type: "send", cleanupId: REPORT, roomKind: "report", clientId: body, body }),
      )
    }

    expect(chatRepo.count(REPORT)).toBe(2)
    const errors = conn.framesOfType("error")
    expect(errors).toHaveLength(1)
    expect((errors[0] as { code: string }).code).toBe("RATE_LIMITED")
  })

  it("fires the @city forward when a report message mentions the report's jurisdiction", async () => {
    reportChat = makeReportChat(true)
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report" }))
    await handleClientFrame(
      session,
      JSON.stringify({ type: "send", cleanupId: REPORT, roomKind: "report", clientId: "c1", body: "pls fix @sf" }),
    )
    await new Promise((r) => setTimeout(r, 0))

    expect(mail.reportCalls).toHaveLength(1)
    expect(mail.reportCalls[0]!.toAddr).toBe("fix@sf.gov")
    expect(mail.reportCalls[0]!.geoid).toBe("0600001")
    expect(mail.reportCalls[0]!.text).toContain("@sf")
  })

  it("DEDUPES the @city forward within the window (a flood can't email-bomb the jurisdiction)", async () => {
    reportChat = makeReportChat(true)
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report" }))
    for (const clientId of ["c1", "c2", "c3"]) {
      await handleClientFrame(
        session,
        JSON.stringify({ type: "send", cleanupId: REPORT, roomKind: "report", clientId, body: "@sf urgent" }),
      )
    }
    await new Promise((r) => setTimeout(r, 0))

    expect(mail.reportCalls).toHaveLength(1)
  })

  it("does NOT forward a report message that mentions no city handle", async () => {
    reportChat = makeReportChat(true)
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report" }))
    await handleClientFrame(
      session,
      JSON.stringify({ type: "send", cleanupId: REPORT, roomKind: "report", clientId: "c1", body: "just chatting" }),
    )
    await new Promise((r) => setTimeout(r, 0))

    expect(mail.reportCalls).toHaveLength(0)
  })

  it("serves report history to an anonymous viewer (public-read, null viewer)", async () => {
    reportChat = makeReportChat(true)
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report" }))
    await handleClientFrame(
      session,
      JSON.stringify({ type: "send", cleanupId: REPORT, roomKind: "report", clientId: "c1", body: "public msg" }),
    )

    const page = await chatRepo.reportHistory(REPORT, undefined, 30, null)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.roomKind).toBe("report")
    expect(page.items[0]!.body).toBe("public msg")
  })
})

describe("report chat gateway — member-only send/typing + read watermark (D-C3)", () => {
  it("still authorizes a report JOIN by a NON-member socket (public join preserved)", async () => {
    reportChat = makeReportChat(false)
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report" }))

    expect(conn.framesOfType("error")).toHaveLength(0)
    expect(conn.framesOfType("presence_snapshot")).toHaveLength(1)
    expect(session.joined.has(`report:${REPORT}`)).toBe(true)
  })

  it("refuses a report SEND by a non-member with a single room-scoped FORBIDDEN frame (no persist, no broadcast)", async () => {
    reportChat = makeReportChat(false)
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report" }))
    await handleClientFrame(
      session,
      JSON.stringify({ type: "send", cleanupId: REPORT, roomKind: "report", clientId: "c1", body: "let me in" }),
    )

    const errors = conn.framesOfType("error")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ type: "error", code: "FORBIDDEN", roomKind: "report", cleanupId: REPORT })
    expect(conn.framesOfType("ack")).toHaveLength(0)
    expect(conn.framesOfType("message")).toHaveLength(0)
    expect(chatRepo.count(REPORT)).toBe(0)
  })

  it("FAILS CLOSED on report SEND and TYPING when no membership source is wired", async () => {
    // deps.reportChat omitted entirely. The gate that decides who may post does not exist, so there is
    // nothing to authorize against and the frame is refused — the group lane's stance. (This used to
    // fall through to "authorized", so a wiring that forgot reportChat made the room world-writable.)
    reportChat = undefined
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report" }))
    // The public READ join is unaffected — only send/typing require the membership source.
    expect(session.joined.has(`report:${REPORT}`)).toBe(true)
    await handleClientFrame(
      session,
      JSON.stringify({ type: "send", cleanupId: REPORT, roomKind: "report", clientId: "c1", body: "unwired" }),
    )
    await handleClientFrame(session, JSON.stringify({ type: "typing", cleanupId: REPORT, roomKind: "report" }))

    const errors = conn.framesOfType("error")
    expect(errors).toHaveLength(2)
    expect(errors.every((e) => (e as { code: string }).code === "FORBIDDEN")).toBe(true)
    expect(conn.framesOfType("ack")).toHaveLength(0)
    expect(chatRepo.count(REPORT)).toBe(0)
  })

  it("persists + broadcasts + acks a report SEND by a MEMBER, and still fires the @city forward", async () => {
    reportChat = makeReportChat(true)
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    // A second socket in the same room to observe the broadcast (excludeConnId omits the sender).
    const observerConn = new MockConnection("B")
    const observer = sessionFor(ALICE, observerConn)
    await handleClientFrame(observer, JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report" }))
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report" }))
    await handleClientFrame(
      session,
      JSON.stringify({ type: "send", cleanupId: REPORT, roomKind: "report", clientId: "c1", body: "fix it @sf" }),
    )
    await new Promise((r) => setTimeout(r, 0))

    // persisted through the shipped deps.chat.persist({ roomKind: "report" }) path
    expect(chatRepo.count(REPORT)).toBe(1)
    // ack to the sender
    const acks = conn.framesOfType("ack")
    expect(acks).toHaveLength(1)
    expect((acks[0] as { message: { roomKind?: string } }).message.roomKind).toBe("report")
    // broadcast (excludeConnId) reaches the other socket, not the sender
    expect(observerConn.framesOfType("message")).toHaveLength(1)
    expect(conn.framesOfType("message")).toHaveLength(0)
    // @city hook still fires
    expect(mail.reportCalls).toHaveLength(1)
    expect(mail.reportCalls[0]!.geoid).toBe("0600001")
  })

  it("advances the report read watermark on ACK (was a no-op)", async () => {
    const rc = makeReportChat(true)
    reportChat = rc
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report" }))
    await handleClientFrame(session, JSON.stringify({ type: "send", cleanupId: REPORT, roomKind: "report", clientId: "c1", body: "hi" }))
    const UP_TO = "55555555-5555-5555-5555-555555555555"
    await handleClientFrame(
      session,
      JSON.stringify({ type: "ack", cleanupId: REPORT, roomKind: "report", upToId: UP_TO }),
    )

    expect(rc.advanceReadWatermark).toHaveBeenCalledTimes(1)
    expect(rc.advanceReadWatermark).toHaveBeenCalledWith(REPORT, ALICE, UP_TO)
  })

  it("suppresses report TYPING from a non-member (error frame, no typing broadcast)", async () => {
    reportChat = makeReportChat(false)
    const conn = new MockConnection("A")
    const session = sessionFor(ALICE, conn)
    // Observer joins to prove no typing frame is fanned out.
    const observerConn = new MockConnection("B")
    const observer = sessionFor(ALICE, observerConn)
    await handleClientFrame(observer, JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report" }))
    await handleClientFrame(session, JSON.stringify({ type: "join", cleanupId: REPORT, roomKind: "report" }))
    observerConn.sent.length = 0
    await handleClientFrame(session, JSON.stringify({ type: "typing", cleanupId: REPORT, roomKind: "report" }))

    const errors = conn.framesOfType("error")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: "FORBIDDEN", roomKind: "report", cleanupId: REPORT })
    expect(observerConn.framesOfType("typing")).toHaveLength(0)
  })
})

describe("GET /reports/:id/messages visibility gate", () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
  })

  async function harness(): Promise<FastifyInstance> {
    const env = loadEnv({ NODE_ENV: "test" })
    const stores = makeInMemoryStores()
    const cache = new InMemoryCacheClient(() => Date.now())
    const authServices = buildAuthServices({
      stores,
      cache,
      mailer: new FakeMailer(),
      oauthConfig: {},
      verifier: new StubJwksVerifier(),
      now: () => Date.now(),
    })
    const discussionRepo = new InMemoryDiscussionRepository()
    discussionRepo.seedReport({ id: HELD_REPORT, status: "held", visibility: "public", reporterUserId: null })
    discussionRepo.seedReport({ id: REPORT, status: "published", visibility: "public", reporterUserId: null })
    const blocks = new InMemoryBlocksRepository()
    const built = await buildServer({
      env,
      authServices,
      chatOverrides: {
        isMember: () => Promise.resolve(true),
        threadsRepo: new InMemoryThreadsRepository(),
        chatRepo: new InMemoryChatRepository(),
        dmRepo: new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b)),
        blocksRepo: blocks,
      },
      discussionOverrides: { repo: discussionRepo },
    })
    app = built
    return built
  }

  it("404s an anonymous read of a HELD report's chat (non-leakage)", async () => {
    const built = await harness()
    const res = await built.inject({ method: "GET", url: `/v1/reports/${HELD_REPORT}/messages` })
    expect(res.statusCode).toBe(404)
  })

  it("200s an anonymous read of a PUBLISHED + PUBLIC report's chat", async () => {
    const built = await harness()
    const res = await built.inject({ method: "GET", url: `/v1/reports/${REPORT}/messages` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items).toEqual([])
    expect(body.nextCursor).toBeNull()
  })
})
