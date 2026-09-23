import { describe, it, expect, afterEach, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { makeServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { makeAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import type { ConversationRoutesOverrides } from "../../src/routes/conversations.routes.js"

const ROOM_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ROOM_KINDS = ["cleanup", "dm", "report", "group"] as const

interface Harness {
  app: FastifyInstance
  token: string
  setMuted: ReturnType<typeof vi.fn>
  setHidden: ReturnType<typeof vi.fn>
  markRoomRead: ReturnType<typeof vi.fn>
}

let current: FastifyInstance | undefined

afterEach(async () => {
  await current?.close()
  current = undefined
})

async function harnessWithoutGate(): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test" })
  const mailer = new FakeMailer()
  const authServices = makeAuthServices({
    stores: makeInMemoryStores(),
    cache: new InMemoryCacheClient(() => Date.now()),
    mailer,
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  const setMuted = vi.fn(() => Promise.resolve())
  const setHidden = vi.fn(() => Promise.resolve())
  const markRoomRead = vi.fn(() => Promise.resolve())
  const overridesMissingGate = {
    repo: {
      isMuted: () => Promise.resolve(false),
      setMuted,
      mutedRoomIdsFor: () => Promise.resolve(new Set<string>()),
    },
    hides: { setHidden, hiddenAtFor: () => Promise.resolve(new Map<string, Date>()) },
    markRoomRead,
  } as unknown as ConversationRoutesOverrides

  const app = await makeServer({
    env,
    authServices,
    conversationRoutesOverrides: overridesMissingGate,
  })
  current = app

  const email = "outsider@example.com"
  await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "mobile" },
    payload: { email, code: mailer.lastOtpFor(email)! },
  })
  const token = (verify.json() as { token: string }).token
  return { app, token, setMuted, setHidden, markRoomRead }
}

describe("conversation routes never run ungated when a test override omits the gate", () => {
  it.each(ROOM_KINDS)("does not mute a %s room without a participation check", async (kind) => {
    const h = await harnessWithoutGate()
    const res = await h.app.inject({
      method: "PUT",
      url: "/v1/conversations/mute",
      headers: { authorization: `Bearer ${h.token}` },
      payload: { roomKind: kind, roomId: ROOM_ID, muted: true },
    })
    expect(res.statusCode).not.toBe(200)
    expect(h.setMuted).not.toHaveBeenCalled()
  })

  it.each(ROOM_KINDS)("does not hide a %s room without a participation check", async (kind) => {
    const h = await harnessWithoutGate()
    const res = await h.app.inject({
      method: "PUT",
      url: "/v1/conversations/hidden",
      headers: { authorization: `Bearer ${h.token}` },
      payload: { roomKind: kind, roomId: ROOM_ID, hidden: true },
    })
    expect(res.statusCode).not.toBe(200)
    expect(h.setHidden).not.toHaveBeenCalled()
  })

  it.each(ROOM_KINDS)(
    "does not mark a %s room read without a participation check",
    async (kind) => {
      const h = await harnessWithoutGate()
      const res = await h.app.inject({
        method: "PUT",
        url: "/v1/threads/read",
        headers: { authorization: `Bearer ${h.token}` },
        payload: { roomKind: kind, roomId: ROOM_ID },
      })
      expect(res.statusCode).not.toBe(200)
      expect(h.markRoomRead).not.toHaveBeenCalled()
    },
  )
})
