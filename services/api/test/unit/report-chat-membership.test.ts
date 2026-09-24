import { describe, it, expect, afterEach, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import type { ChatMessageDTO } from "@civfix/shared"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryChatRepository, InMemoryThreadsRepository } from "../helpers/chat.js"
import { InMemoryDiscussionRepository } from "../helpers/discussion.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import type { ReportChatRepository } from "../../src/services/report-chat-repository.drizzle.js"

const REPORT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

function makeFakeReportChat(
  over: {
    isMember?: boolean
  } = {},
): ReportChatRepository & {
  join: ReturnType<typeof vi.fn>
  leave: ReturnType<typeof vi.fn>
  isMember: ReturnType<typeof vi.fn>
} {
  const isMember = vi.fn(() => Promise.resolve(over.isMember ?? false))
  const join = vi.fn(() => Promise.resolve())
  const leave = vi.fn(() => Promise.resolve())
  const notImpl = (name: string) => () => {
    throw new Error(`fake reportChat.${name} not implemented`)
  }
  return {
    isMember,
    join,
    leave,
    roleOf: () => Promise.resolve(over.isMember ? ("member" as const) : null),
    advanceReadWatermark: notImpl("advanceReadWatermark") as never,
    markRead: notImpl("markRead") as never,
    insertSystemMessage: notImpl("insertSystemMessage") as never,
    listMemberIds: notImpl("listMemberIds") as never,
    countMembers: notImpl("countMembers") as never,
    listMembers: notImpl("listMembers") as never,
  }
}

interface Harness {
  app: FastifyInstance
  token: string
  userId: string
  reportChat: ReturnType<typeof makeFakeReportChat>
  chatRepo: InMemoryChatRepository
  discussionRepo: InMemoryDiscussionRepository
}

let current: Harness | undefined

async function makeHarness(
  opts: {
    isMember?: boolean
    seedChat?: (chatRepo: InMemoryChatRepository, userId: string) => void
  } = {},
): Promise<Harness> {
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

  const discussionRepo = new InMemoryDiscussionRepository()
  discussionRepo.seedReport({
    id: REPORT,
    status: "published",
    visibility: "public",
    reporterUserId: null,
  })
  const chatRepo = new InMemoryChatRepository()
  const blocks = new InMemoryBlocksRepository()
  const reportChat = makeFakeReportChat({
    ...(opts.isMember !== undefined ? { isMember: opts.isMember } : {}),
  })

  const app = await buildServer({
    env,
    authServices,
    chatOverrides: {
      isMember: () => Promise.resolve(true),
      threadsRepo: new InMemoryThreadsRepository(),
      chatRepo,
      dmRepo: new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b)),
      blocksRepo: blocks,
      reportChat,
    },
    discussionOverrides: { repo: discussionRepo },
  })

  const email = "member@example.com"
  await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
  const code = mailer.lastOtpFor(email)!
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "mobile" },
    payload: { email, code },
  })
  const body = verify.json()
  const userId: string = body.user.id
  if (opts.seedChat) opts.seedChat(chatRepo, userId)

  const h: Harness = { app, token: body.token, userId, reportChat, chatRepo, discussionRepo }
  current = h
  return h
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

async function seedReportMessage(
  chatRepo: InMemoryChatRepository,
  userId: string,
): Promise<string> {
  const id = "dddddddd-dddd-dddd-dddd-dddddddddddd"
  const msg: ChatMessageDTO = await chatRepo.insertMessage(
    { cleanupId: REPORT, userId, body: "hello", roomKind: "report", kind: "text" },
    id,
  )
  return msg.id
}

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

describe("POST /reports/:id/chat/join", () => {
  it("200s and joins the caller as a 'member'", async () => {
    const { app, token, userId, reportChat } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: `/v1/reports/${REPORT}/chat/join`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(reportChat.join).toHaveBeenCalledTimes(1)
    expect(reportChat.join).toHaveBeenCalledWith(REPORT, userId, "member")
  })

  it("401s an anonymous join", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "POST", url: `/v1/reports/${REPORT}/chat/join` })
    expect(res.statusCode).toBe(401)
  })

  it("404s joining a report that is not visible (unknown report)", async () => {
    const { app, token, reportChat } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/reports/00000000-0000-0000-0000-000000000000/chat/join",
      headers: auth(token),
    })
    expect(res.statusCode).toBe(404)
    expect(reportChat.join).not.toHaveBeenCalled()
  })
})

describe("POST /reports/:id/chat/leave", () => {
  it("200s and leaves the caller", async () => {
    const { app, token, userId, reportChat } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: `/v1/reports/${REPORT}/chat/leave`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(reportChat.leave).toHaveBeenCalledTimes(1)
    expect(reportChat.leave).toHaveBeenCalledWith(REPORT, userId)
  })

  it("401s an anonymous leave", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "POST", url: `/v1/reports/${REPORT}/chat/leave` })
    expect(res.statusCode).toBe(401)
  })
})

describe("DELETE /reports/:id/messages/:messageId (membership gate)", () => {
  it("403s a NON-member (isMember -> false), never touching softDeleteReport", async () => {
    const { app, token, chatRepo } = await makeHarness({ isMember: false })
    const messageId = await seedReportMessage(chatRepo, "someone-else")
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/reports/${REPORT}/messages/${messageId}`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(403)
    expect(chatRepo.count(REPORT)).toBe(1)
  })

  it("lets a MEMBER delete their own message (isMember -> true) -> 200 tombstone", async () => {
    let userId = ""
    const { app, token, chatRepo, ...rest } = await makeHarness({
      isMember: true,
      seedChat: (_repo, uid) => {
        userId = uid
      },
    })
    void rest
    const messageId = await seedReportMessage(chatRepo, userId)
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/reports/${REPORT}/messages/${messageId}`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().deletedAt).not.toBeNull()
    expect(chatRepo.count(REPORT)).toBe(0)
  })
})

describe("POST /reports/:id/messages/:messageId/reactions (membership gate)", () => {
  it("403s a NON-member (isMember -> false), keeping the room's Join copy", async () => {
    const { app, token, chatRepo, reportChat } = await makeHarness({ isMember: false })
    const messageId = await seedReportMessage(chatRepo, "someone-else")
    const res = await app.inject({
      method: "POST",
      url: `/v1/reports/${REPORT}/messages/${messageId}/reactions`,
      headers: auth(token),
      payload: { emoji: "like" },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().message).toBe("Join the chat to react to messages.")
    expect(reportChat.isMember).toHaveBeenCalledTimes(1)
  })

  it("404s (never 403) when the report is no longer visible; visibility gates before membership", async () => {
    const { app, token, chatRepo, discussionRepo, reportChat } = await makeHarness({
      isMember: true,
    })
    const messageId = await seedReportMessage(chatRepo, "someone-else")
    discussionRepo.seedReport({
      id: REPORT,
      status: "held",
      visibility: "public",
      reporterUserId: null,
    })
    const res = await app.inject({
      method: "POST",
      url: `/v1/reports/${REPORT}/messages/${messageId}/reactions`,
      headers: auth(token),
      payload: { emoji: "like" },
    })
    expect(res.statusCode).toBe(404)
    expect(reportChat.isMember).not.toHaveBeenCalled()
  })

  it("lets a MEMBER react (isMember -> true) -> 200 with the reaction applied", async () => {
    let userId = ""
    const { app, token, chatRepo } = await makeHarness({
      isMember: true,
      seedChat: (_repo, uid) => {
        userId = uid
      },
    })
    const messageId = await seedReportMessage(chatRepo, "someone-else")
    void userId
    const res = await app.inject({
      method: "POST",
      url: `/v1/reports/${REPORT}/messages/${messageId}/reactions`,
      headers: auth(token),
      payload: { emoji: "like" },
    })
    expect(res.statusCode).toBe(200)
    const dto = res.json()
    const like = (dto.reactions as { emoji: string; count: number; mine: boolean }[]).find(
      (r) => r.emoji === "like",
    )
    expect(like).toMatchObject({ count: 1, mine: true })
  })
})
