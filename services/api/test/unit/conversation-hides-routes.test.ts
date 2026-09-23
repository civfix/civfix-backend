import { describe, it, expect, afterEach, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import type { ConversationRoutesOverrides } from "../../src/routes/conversations.routes.js"
import type { ConversationMutesRepository } from "../../src/services/conversation-mutes-repository.drizzle.js"
import type { ConversationHidesRepository } from "../../src/services/conversation-hides-repository.drizzle.js"

const ROOM_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

function makeMutesRepo(): ConversationMutesRepository {
  return {
    isMuted: () => Promise.resolve(false),
    setMuted: () => Promise.resolve(),
    mutedRoomIdsFor: () => Promise.resolve(new Set<string>()),
  }
}

function makeHidesRepo(): ConversationHidesRepository & { setHidden: ReturnType<typeof vi.fn> } {
  const setHidden = vi.fn(() => Promise.resolve())
  return { setHidden, hiddenAtFor: () => Promise.resolve(new Map<string, Date>()) }
}

interface Harness {
  app: FastifyInstance
  token: string
  userId: string
  hides: ReturnType<typeof makeHidesRepo>
}

type Participates = NonNullable<ConversationRoutesOverrides["participates"]>

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

  const hides = makeHidesRepo()
  const conversationRoutesOverrides: ConversationRoutesOverrides = {
    repo: makeMutesRepo(),
    hides,
    participates: participates ?? (() => Promise.resolve(true)),
  }

  const app = await buildServer({ env, authServices, conversationRoutesOverrides })

  const email = "hider@example.com"
  await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
  const code = mailer.lastOtpFor(email)!
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "mobile" },
    payload: { email, code },
  })
  const body = verify.json()

  const h: Harness = { app, token: body.token, userId: body.user.id, hides }
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

describe("PUT /conversations/hidden", () => {
  it("200s and hides a dm for the caller only, echoing hidden:true", async () => {
    const { app, token, userId, hides } = await makeHarness()
    const res = await app.inject({
      method: "PUT",
      url: "/v1/conversations/hidden",
      headers: auth(token),
      payload: { roomKind: "dm", roomId: ROOM_ID, hidden: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ hidden: true })
    expect(hides.setHidden).toHaveBeenCalledWith(userId, "dm", ROOM_ID, true)
  })

  it("200s and un-hides, echoing hidden:false", async () => {
    const { app, token, userId, hides } = await makeHarness()
    const res = await app.inject({
      method: "PUT",
      url: "/v1/conversations/hidden",
      headers: auth(token),
      payload: { roomKind: "group", roomId: ROOM_ID, hidden: false },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ hidden: false })
    expect(hides.setHidden).toHaveBeenCalledWith(userId, "group", ROOM_ID, false)
  })

  it("422s an unknown roomKind without touching the store", async () => {
    const { app, token, hides } = await makeHarness()
    const res = await app.inject({
      method: "PUT",
      url: "/v1/conversations/hidden",
      headers: auth(token),
      payload: { roomKind: "report_discussion", roomId: ROOM_ID, hidden: true },
    })
    expect(res.statusCode).toBe(422)
    expect(hides.setHidden).not.toHaveBeenCalled()
  })

  it("401s an anonymous request", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "PUT",
      url: "/v1/conversations/hidden",
      payload: { roomKind: "dm", roomId: ROOM_ID, hidden: true },
    })
    expect(res.statusCode).toBe(401)
  })

  it("403s a room the caller does not participate in, and writes NOTHING", async () => {
    const { app, token, hides } = await makeHarness(() => Promise.resolve(false))
    const res = await app.inject({
      method: "PUT",
      url: "/v1/conversations/hidden",
      headers: auth(token),
      payload: { roomKind: "dm", roomId: ROOM_ID, hidden: true },
    })
    expect(res.statusCode).toBe(403)
    expect(hides.setHidden).not.toHaveBeenCalled()
  })

  it("passes the room through to the participation gate before writing", async () => {
    const seen: Array<[string, string]> = []
    const { app, token, hides } = await makeHarness((roomKind, roomId) => {
      seen.push([roomKind, roomId])
      return Promise.resolve(true)
    })
    const res = await app.inject({
      method: "PUT",
      url: "/v1/conversations/hidden",
      headers: auth(token),
      payload: { roomKind: "report", roomId: ROOM_ID, hidden: true },
    })
    expect(res.statusCode).toBe(200)
    expect(seen).toEqual([["report", ROOM_ID]])
    expect(hides.setHidden).toHaveBeenCalledTimes(1)
  })
})
