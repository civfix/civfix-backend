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
 * Offline HTTP tests for the author self-delete routes:
 *   DELETE /dm/:threadId/messages/:messageId         (DM, participant + sender gated)
 *   DELETE /cleanups/:cleanupId/messages/:messageId  (cleanup chat, membership + sender gated)
 * Both run over the in-memory repos injected via chatOverrides and return the tombstoned ChatMessageDTO.
 */

const PEER = "44444444-4444-4444-4444-444444444444"
const CLEANUP = "55555555-5555-5555-5555-555555555555"

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
  chatRepo: InMemoryChatRepository
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
  const chatRepo = new InMemoryChatRepository()
  const overrides: ChatGatewayOverrides = {
    // The member is whoever the test signs in (membership gate for the cleanup delete).
    isMember: () => Promise.resolve(true),
    threadsRepo: new InMemoryThreadsRepository(),
    dmRepo,
    chatRepo,
    blocksRepo: blocks,
  }
  const app = await makeServer({ env, authServices, chatOverrides: overrides })
  current = app
  return { app, mailer, dmRepo, chatRepo }
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

describe("DELETE /dm/:threadId/messages/:messageId", () => {
  it("the author soft-deletes their own DM message and gets the tombstone back", async () => {
    const { app, mailer, dmRepo } = await harness()
    const { token, userId } = await signIn(app, mailer, "me@example.com")
    dmRepo.registerUser({ id: userId, displayName: "Me", handle: "me" })
    const thread = await dmRepo.openOrCreateThread(userId, PEER)
    const msg = await dmRepo.persist({ threadId: thread.id, senderId: userId, body: "oops" })

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/dm/${thread.id}/messages/${msg.id}`,
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
    })

    expect(res.statusCode).toBe(200)
    const dto = res.json()
    expect(dto.id).toBe(msg.id)
    expect(dto.deletedAt).toBeTruthy()
    // The message is now excluded from history (tombstoned).
    const page = await dmRepo.history(thread.id, undefined, 30, userId)
    expect(page.items.find((m) => m.id === msg.id)).toBeUndefined()
  })

  it("403s deleting a message the caller did not send", async () => {
    const { app, mailer, dmRepo } = await harness()
    const { token, userId } = await signIn(app, mailer, "me@example.com")
    dmRepo.registerUser({ id: userId, displayName: "Me", handle: "me" })
    const thread = await dmRepo.openOrCreateThread(userId, PEER)
    // A message authored by the PEER, not the caller.
    const peerMsg = await dmRepo.persist({ threadId: thread.id, senderId: PEER, body: "theirs" })

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/dm/${thread.id}/messages/${peerMsg.id}`,
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe("DELETE /cleanups/:cleanupId/messages/:messageId", () => {
  it("the author soft-deletes their own cleanup-chat message and gets the tombstone back", async () => {
    const { app, mailer, chatRepo } = await harness()
    const { token, userId } = await signIn(app, mailer, "me@example.com")
    chatRepo.registerSender({ id: userId, displayName: "Me", handle: "me", bio: null })
    const msg = await chatRepo.insertMessage(
      { cleanupId: CLEANUP, userId, body: "hello" },
      "66666666-6666-6666-6666-666666666666",
    )

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/cleanups/${CLEANUP}/messages/${msg.id}`,
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
    })

    expect(res.statusCode).toBe(200)
    const dto = res.json()
    expect(dto.id).toBe(msg.id)
    expect(dto.deletedAt).toBeTruthy()
    expect(chatRepo.count(CLEANUP)).toBe(0)
  })
})
