import { describe, it, expect, afterEach, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import type { ConversationMutesOverrides } from "../../src/routes/conversations.routes.js"
import type { ConversationMutesRepository } from "../../src/services/conversation-mutes-repository.drizzle.js"

/**
 * Route-level tests for PUT /conversations/mute, run with NO database: a fake
 * ConversationMutesRepository is injected via buildServer(opts.conversationMutesOverrides), and a full
 * in-memory auth bundle mints a real bearer session. Bearer transport is CSRF-exempt (see auth/csrf.ts),
 * so this state-changing PUT needs only the Authorization header.
 */

const ROOM_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

function makeFakeRepo(): ConversationMutesRepository & {
  isMuted: ReturnType<typeof vi.fn>
  setMuted: ReturnType<typeof vi.fn>
  mutedRoomIdsFor: ReturnType<typeof vi.fn>
} {
  const isMuted = vi.fn(() => Promise.resolve(false))
  const setMuted = vi.fn(() => Promise.resolve())
  const mutedRoomIdsFor = vi.fn(() => Promise.resolve(new Set<string>()))
  return { isMuted, setMuted, mutedRoomIdsFor }
}

interface Harness {
  app: FastifyInstance
  token: string
  userId: string
  repo: ReturnType<typeof makeFakeRepo>
}

let current: Harness | undefined

async function makeHarness(): Promise<Harness> {
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

  const repo = makeFakeRepo()
  const conversationMutesOverrides: ConversationMutesOverrides = { repo }

  const app = await buildServer({ env, authServices, conversationMutesOverrides })

  const email = "muter@example.com"
  await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
  const code = mailer.lastOtpFor(email)!
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "mobile" },
    payload: { email, code },
  })
  const body = verify.json()

  const h: Harness = { app, token: body.token, userId: body.user.id, repo }
  current = h
  return h
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

describe("PUT /conversations/mute", () => {
  it("200s and mutes a report room, echoing muted:true", async () => {
    const { app, token, userId, repo } = await makeHarness()
    const res = await app.inject({
      method: "PUT",
      url: "/v1/conversations/mute",
      headers: auth(token),
      payload: { roomKind: "report", roomId: ROOM_ID, muted: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ muted: true })
    expect(repo.setMuted).toHaveBeenCalledTimes(1)
    expect(repo.setMuted).toHaveBeenCalledWith(userId, "report", ROOM_ID, true)
  })

  it("200s and unmutes, echoing muted:false", async () => {
    const { app, token, userId, repo } = await makeHarness()
    const res = await app.inject({
      method: "PUT",
      url: "/v1/conversations/mute",
      headers: auth(token),
      payload: { roomKind: "report", roomId: ROOM_ID, muted: false },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ muted: false })
    expect(repo.setMuted).toHaveBeenCalledTimes(1)
    expect(repo.setMuted).toHaveBeenCalledWith(userId, "report", ROOM_ID, false)
  })

  it("mutes a cleanup room", async () => {
    const { app, token, userId, repo } = await makeHarness()
    const res = await app.inject({
      method: "PUT",
      url: "/v1/conversations/mute",
      headers: auth(token),
      payload: { roomKind: "cleanup", roomId: ROOM_ID, muted: true },
    })
    expect(res.statusCode).toBe(200)
    expect(repo.setMuted).toHaveBeenCalledWith(userId, "cleanup", ROOM_ID, true)
  })

  it("mutes a dm room", async () => {
    const { app, token, userId, repo } = await makeHarness()
    const res = await app.inject({
      method: "PUT",
      url: "/v1/conversations/mute",
      headers: auth(token),
      payload: { roomKind: "dm", roomId: ROOM_ID, muted: true },
    })
    expect(res.statusCode).toBe(200)
    expect(repo.setMuted).toHaveBeenCalledWith(userId, "dm", ROOM_ID, true)
  })

  it("422s a report_discussion roomKind (not a supported mute target) without calling the repo", async () => {
    const { app, token, repo } = await makeHarness()
    const res = await app.inject({
      method: "PUT",
      url: "/v1/conversations/mute",
      headers: auth(token),
      payload: { roomKind: "report_discussion", roomId: ROOM_ID, muted: true },
    })
    expect(res.statusCode).toBe(422)
    expect(repo.setMuted).not.toHaveBeenCalled()
  })

  it("401s an anonymous request", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "PUT",
      url: "/v1/conversations/mute",
      payload: { roomKind: "report", roomId: ROOM_ID, muted: true },
    })
    expect(res.statusCode).toBe(401)
  })
})
