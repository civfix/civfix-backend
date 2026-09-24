import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import type { UserMentionDTO } from "@civfix/shared"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import { InMemoryChatRepository, InMemoryThreadsRepository } from "../helpers/chat.js"
import type { ChatGatewayOverrides } from "../../src/routes/chat.routes.js"

const PEER = "44444444-4444-4444-4444-444444444444"

let current: FastifyInstance | undefined

afterEach(async () => {
  if (current) {
    await current.close()
    current = undefined
  }
})

async function harness(chatMentions: ChatGatewayOverrides["chatMentions"]): Promise<{
  app: FastifyInstance
  mailer: FakeMailer
  dmRepo: InMemoryDmRepository
}> {
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
  const blocks = new InMemoryBlocksRepository()
  const dmRepo = new InMemoryDmRepository((a, b) => blocks.isBlockedEitherWay(a, b))
  dmRepo.registerUser({ id: PEER, displayName: "Peer", handle: "peer" })
  const overrides: ChatGatewayOverrides = {
    isMember: () => Promise.resolve(true),
    threadsRepo: new InMemoryThreadsRepository(),
    dmRepo,
    chatRepo: new InMemoryChatRepository(),
    blocksRepo: blocks,
    chatMentions,
  }
  const app = await buildServer({ env, authServices, chatOverrides: overrides })
  current = app
  return { app, mailer, dmRepo }
}

async function signIn(
  app: FastifyInstance,
  mailer: FakeMailer,
  email: string,
): Promise<{ token: string; userId: string }> {
  await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
  const code = mailer.lastOtpFor(email)!
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "mobile" },
    payload: { email, code },
  })
  const body = verify.json()
  return { token: body.token, userId: body.user.id }
}

describe("PATCH /dm/:threadId/messages/:messageId re-records mentions", () => {
  it("replaces the edited message's mention set, like the unified edit route", async () => {
    const recorded: { messageId: string; ids: string[] }[] = []
    const resolvedKinds: string[] = []
    const peerMention: UserMentionDTO = { id: PEER, handle: "peer", displayName: "Peer" }
    const { app, mailer, dmRepo } = await harness({
      resolveChatMentions: (input) => {
        resolvedKinds.push(input.kind)
        return Promise.resolve([peerMention])
      },
      recordChatMentions: (messageId, ids) => {
        recorded.push({ messageId, ids })
        return Promise.resolve()
      },
      notifyChatMention: () => Promise.resolve(),
    })
    const { token, userId } = await signIn(app, mailer, "me@example.com")
    dmRepo.registerUser({ id: userId, displayName: "Me", handle: "me" })
    const thread = await dmRepo.openOrCreateThread(userId, PEER)
    const msg = await dmRepo.persist({ threadId: thread.id, senderId: userId, body: "hi" })

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/dm/${thread.id}/messages/${msg.id}`,
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
      payload: { body: "hi @peer" },
    })

    expect(res.statusCode).toBe(200)
    expect(resolvedKinds).toEqual(["dm"])
    expect(recorded).toEqual([{ messageId: msg.id, ids: [PEER] }])
  })
})
