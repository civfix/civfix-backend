import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { makeServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { makeAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import {
  InMemoryBlocksRepository,
  InMemoryDmRepository,
} from "../../src/services/dm-repository.memory.js"
import { InMemoryChatRepository, InMemoryThreadsRepository } from "../helpers/chat.js"
import type { ChatGatewayOverrides } from "../../src/routes/chat.routes.js"

/**
 * The hate-slur content gate on the DM edit route (App Store guideline 1.2a): a slur in the edited body
 * is a 422. Mobile bearer transport is CSRF-exempt, so no token is needed.
 */

const PEER = "44444444-4444-4444-4444-444444444444"

let current: FastifyInstance | undefined

afterEach(async () => {
  if (current) {
    await current.close()
    current = undefined
  }
})

async function harness(): Promise<{
  app: FastifyInstance
  mailer: FakeMailer
  dmRepo: InMemoryDmRepository
}> {
  const env = loadEnv({ NODE_ENV: "test" })
  const stores = makeInMemoryStores()
  const cache = new InMemoryCacheClient(() => Date.now())
  const mailer = new FakeMailer()
  const authServices = makeAuthServices({
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
  }
  const app = await makeServer({ env, authServices, chatOverrides: overrides })
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

describe("PATCH /dm/:threadId/messages/:messageId slur gate (F1)", () => {
  it("422s an edited DM body that contains a hate slur", async () => {
    const { app, mailer, dmRepo } = await harness()
    const { token, userId } = await signIn(app, mailer, "me@example.com")
    dmRepo.registerUser({ id: userId, displayName: "Me", handle: "me" })
    const thread = await dmRepo.openOrCreateThread(userId, PEER)
    const msg = await dmRepo.persist({ threadId: thread.id, senderId: userId, body: "ok" })

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/dm/${thread.id}/messages/${msg.id}`,
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
      payload: { body: "you retard" },
    })
    expect(res.statusCode).toBe(422)
  })

  it("allows an edited DM body with no slur (general profanity passes)", async () => {
    const { app, mailer, dmRepo } = await harness()
    const { token, userId } = await signIn(app, mailer, "me@example.com")
    dmRepo.registerUser({ id: userId, displayName: "Me", handle: "me" })
    const thread = await dmRepo.openOrCreateThread(userId, PEER)
    const msg = await dmRepo.persist({ threadId: thread.id, senderId: userId, body: "ok" })

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/dm/${thread.id}/messages/${msg.id}`,
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
      payload: { body: "this is damn slow" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().body).toBe("this is damn slow")
  })
})
