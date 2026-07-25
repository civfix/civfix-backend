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

/** L9 participation gate seam (see ConversationMutesOverrides.participates). */
type Participates = NonNullable<ConversationMutesOverrides["participates"]>

let current: Harness | undefined

async function makeHarness(participates?: Participates): Promise<Harness> {
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
  const conversationMutesOverrides: ConversationMutesOverrides = {
    repo,
    ...(participates ? { participates } : {}),
  }

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

  it("422s an unknown roomKind (not a valid room kind) without calling the repo", async () => {
    const { app, token, repo } = await makeHarness()
    const res = await app.inject({
      method: "PUT",
      url: "/v1/conversations/mute",
      headers: auth(token),
      // "report_discussion" was removed from RoomKind with the discussion system, so it is now an invalid
      // enum value the request schema rejects before the mute-target gate.
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

/**
 * L9 (2026-07-24 review): the route wrote an arbitrary roomId with NO existence or membership check, so
 * an authenticated client could insert unbounded junk rows into conversation_mutes.
 */
describe("PUT /conversations/mute — participation gate (L9)", () => {
  it("403s a room the caller does not participate in, and writes NOTHING", async () => {
    const { app, token, repo } = await makeHarness(() => Promise.resolve(false))
    const res = await app.inject({
      method: "PUT",
      url: "/v1/conversations/mute",
      headers: auth(token),
      payload: { roomKind: "dm", roomId: ROOM_ID, muted: true },
    })
    expect(res.statusCode).toBe(403)
    expect(repo.setMuted).not.toHaveBeenCalled()
  })

  it("200s and writes when the caller does participate, passing the room through to the gate", async () => {
    const seen: Array<[string, string]> = []
    const { app, token, userId, repo } = await makeHarness((roomKind, roomId) => {
      seen.push([roomKind, roomId])
      return Promise.resolve(true)
    })
    const res = await app.inject({
      method: "PUT",
      url: "/v1/conversations/mute",
      headers: auth(token),
      payload: { roomKind: "group", roomId: ROOM_ID, muted: true },
    })
    expect(res.statusCode).toBe(200)
    expect(seen).toEqual([["group", ROOM_ID]])
    expect(repo.setMuted).toHaveBeenCalledWith(userId, "group", ROOM_ID, true)
  })

  it("rejects BEFORE the gate for an unmutable room kind (422, gate never consulted)", async () => {
    const gate = vi.fn(() => Promise.resolve(true))
    const { app, token } = await makeHarness(gate)
    const res = await app.inject({
      method: "PUT",
      url: "/v1/conversations/mute",
      headers: auth(token),
      payload: { roomKind: "report_discussion", roomId: ROOM_ID, muted: true },
    })
    expect(res.statusCode).toBe(422)
    expect(gate).not.toHaveBeenCalled()
  })
})
