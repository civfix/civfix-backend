import { describe, it, expect, afterEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryThreadsRepository } from "../helpers/chat.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import type { ChatGatewayOverrides } from "../../src/routes/chat.routes.js"
import {
  THREAD_READ_RATE_LIMIT,
  type ConversationRoutesOverrides,
} from "../../src/routes/conversations.routes.js"
import type { ConversationMutesRepository } from "../../src/services/conversation-mutes-repository.drizzle.js"
import type { ReportChatRepository } from "../../src/services/report-chat-repository.drizzle.js"
import type { ChatGroupRepository } from "../../src/services/chat-group-repository.drizzle.js"

const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const OTHER = "99999999-9999-9999-9999-999999999999"

function fakeMutes(): ConversationMutesRepository {
  return {
    isMuted: () => Promise.resolve(false),
    setMuted: () => Promise.resolve(),
    mutedRoomIdsFor: () => Promise.resolve(new Set<string>()),
  }
}

function fakeReportChat(markRead: ReportChatRepository["markRead"]): ReportChatRepository {
  const notImpl = (name: string) => () => {
    throw new Error(`fake reportChat.${name} not implemented`)
  }
  return {
    isMember: () => Promise.resolve(true),
    roleOf: () => Promise.resolve("member" as const),
    join: notImpl("join") as never,
    leave: notImpl("leave") as never,
    advanceReadWatermark: notImpl("advanceReadWatermark") as never,
    markRead,
    insertSystemMessage: notImpl("insertSystemMessage") as never,
    listMemberIds: notImpl("listMemberIds") as never,
    countMembers: notImpl("countMembers") as never,
    listMembers: notImpl("listMembers") as never,
  }
}

function fakeGroups(markRead: ChatGroupRepository["markRead"]): ChatGroupRepository {
  return { markRead } as unknown as ChatGroupRepository
}

interface Harness {
  app: FastifyInstance
  token: string
  userId: string
  threadsRepo: InMemoryThreadsRepository
  dmRepo: InMemoryDmRepository
  reportMarkRead: ReturnType<typeof vi.fn>
  groupMarkRead: ReturnType<typeof vi.fn>
  gate: ReturnType<typeof vi.fn>
}

let current: FastifyInstance | undefined

async function makeHarness(participates = true): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test" })
  const stores = makeInMemoryStores()
  const cache = new InMemoryCacheClient(() => Date.now())
  const mailer = new FakeMailer()
  const authServices = buildAuthServices({
    stores,
    cache,
    mailer,
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })

  const threadsRepo = new InMemoryThreadsRepository()
  const blocks = new InMemoryBlocksRepository()
  const dmRepo = new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
  const reportMarkRead = vi.fn(() => Promise.resolve())
  const groupMarkRead = vi.fn(() => Promise.resolve())

  const chatOverrides: ChatGatewayOverrides = {
    isMember: () => Promise.resolve(true),
    threadsRepo,
    dmRepo,
    blocksRepo: blocks,
    reportChat: fakeReportChat(reportMarkRead),
    groups: fakeGroups(groupMarkRead),
  }

  const gate = vi.fn(() => Promise.resolve(participates))
  const conversationRoutesOverrides: ConversationRoutesOverrides = {
    repo: fakeMutes(),
    participates: gate,
  }

  const app = await buildServer({ env, authServices, chatOverrides, conversationRoutesOverrides })
  current = app

  const email = "reader@example.com"
  await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
  const code = mailer.lastOtpFor(email)!
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "mobile" },
    payload: { email, code },
  })
  const body = verify.json()

  return {
    app,
    token: body.token,
    userId: body.user.id,
    threadsRepo,
    dmRepo,
    reportMarkRead,
    groupMarkRead,
    gate,
  }
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

async function markRead(app: FastifyInstance, token: string, roomKind: string, roomId: string) {
  return await app.inject({
    method: "PUT",
    url: "/v1/threads/read",
    headers: auth(token),
    payload: { roomKind, roomId },
  })
}

afterEach(async () => {
  if (current) {
    await current.close()
    current = undefined
  }
})

describe("PUT /threads/read", () => {
  it("drops the inbox's unread count to zero for a cleanup room", async () => {
    const { app, token, userId, threadsRepo } = await makeHarness()
    const cleanupId = threadsRepo.seedCleanup("Beach sweep")
    threadsRepo.addMember(cleanupId, userId, new Date("2026-06-01T10:00:00.000Z"))
    threadsRepo.addMember(cleanupId, OTHER, new Date("2026-06-01T09:00:00.000Z"))
    threadsRepo.addMessage(cleanupId, {
      senderId: OTHER,
      body: "anyone bringing bags?",
      createdAt: new Date("2026-06-01T11:00:00.000Z"),
    })

    const before = await app.inject({
      method: "GET",
      url: "/v1/threads",
      headers: auth(token),
    })
    expect(before.json().items[0].unread).toBe(1)

    const res = await markRead(app, token, "cleanup", cleanupId)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    const after = await app.inject({ method: "GET", url: "/v1/threads", headers: auth(token) })
    expect(after.json().items[0].unread).toBe(0)
  })

  it("advances the dm thread's watermark", async () => {
    const { app, token, userId, dmRepo } = await makeHarness()
    const spy = vi.spyOn(dmRepo, "markRead")
    const res = await markRead(app, token, "dm", ROOM)
    expect(res.statusCode).toBe(200)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![0]).toBe(ROOM)
    expect(spy.mock.calls[0]![1]).toBe(userId)
    expect(spy.mock.calls[0]![2]).toBeInstanceOf(Date)
  })

  it("advances the report chat's watermark", async () => {
    const { app, token, userId, reportMarkRead } = await makeHarness()
    const res = await markRead(app, token, "report", ROOM)
    expect(res.statusCode).toBe(200)
    expect(reportMarkRead).toHaveBeenCalledTimes(1)
    expect(reportMarkRead.mock.calls[0]![0]).toBe(ROOM)
    expect(reportMarkRead.mock.calls[0]![1]).toBe(userId)
  })

  it("advances the group room's watermark", async () => {
    const { app, token, userId, groupMarkRead } = await makeHarness()
    const res = await markRead(app, token, "group", ROOM)
    expect(res.statusCode).toBe(200)
    expect(groupMarkRead).toHaveBeenCalledTimes(1)
    expect(groupMarkRead.mock.calls[0]![0]).toBe(ROOM)
    expect(groupMarkRead.mock.calls[0]![1]).toBe(userId)
  })

  it("422s an unknown room kind before the gate is consulted", async () => {
    const { app, token, gate } = await makeHarness()
    const res = await markRead(app, token, "report_discussion", ROOM)
    expect(res.statusCode).toBe(422)
    expect(gate).not.toHaveBeenCalled()
  })

  it("401s an anonymous request", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "PUT",
      url: "/v1/threads/read",
      payload: { roomKind: "dm", roomId: ROOM },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe("PUT /threads/read — participation gate (L9)", () => {
  it("403s a room the caller does not participate in, and writes NOTHING", async () => {
    const { app, token, dmRepo, reportMarkRead, groupMarkRead } = await makeHarness(false)
    const spy = vi.spyOn(dmRepo, "markRead")
    for (const roomKind of ["cleanup", "dm", "report", "group"] as const) {
      const res = await markRead(app, token, roomKind, ROOM)
      expect(res.statusCode, roomKind).toBe(403)
    }
    expect(spy).not.toHaveBeenCalled()
    expect(reportMarkRead).not.toHaveBeenCalled()
    expect(groupMarkRead).not.toHaveBeenCalled()
  })

  it("passes the exact room through to the gate on every kind", async () => {
    const { app, token, userId, gate } = await makeHarness()
    for (const roomKind of ["cleanup", "dm", "report", "group"] as const) {
      await markRead(app, token, roomKind, ROOM)
    }
    expect(gate.mock.calls.map((c) => c[0])).toEqual(["cleanup", "dm", "report", "group"])
    for (const call of gate.mock.calls) {
      expect(call[1]).toBe(ROOM)
      expect(call[2]).toBe(userId)
    }
  })
})

describe("PUT /threads/read — abuse controls", () => {
  it("carries a per-identity rate limit and the csrf guard", () => {
    expect(THREAD_READ_RATE_LIMIT).toMatchObject({ max: 60, timeWindow: "1 minute" })
    // Whitespace-collapsed so the assertion pins the declaration, not the formatter's line breaks.
    const src = readFileSync(
      new URL("../../src/routes/conversations.routes.ts", import.meta.url),
      "utf8",
    ).replace(/\s+/g, " ")
    const readRoute = src.slice(src.indexOf('"markThreadRead",'))
    expect(readRoute.slice(0, 260)).toContain("preHandler: csrfProtect")
    expect(readRoute.slice(0, 260)).toContain("rateLimit: THREAD_READ_RATE_LIMIT")
  })
})
