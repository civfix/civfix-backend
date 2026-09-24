import { afterEach, describe, expect, it } from "vitest"
import type { FastifyRequest } from "fastify"
import { loadEnv } from "../../src/env.js"
import { resolveWsUser } from "../../src/ws/handshake.js"
import { SessionService } from "../../src/auth/session-service.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"

const USER = "11111111-1111-4111-8111-111111111111"
const previousFlag = process.env.WS_ALLOW_QUERY_TOKEN

afterEach(() => {
  if (previousFlag === undefined) delete process.env.WS_ALLOW_QUERY_TOKEN
  else process.env.WS_ALLOW_QUERY_TOKEN = previousFlag
})

async function sessionToken(): Promise<{ sessions: SessionService; token: string }> {
  const stores = makeInMemoryStores()
  const sessions = new SessionService({
    store: stores.sessions,
    cache: new InMemoryCacheClient(() => Date.now()),
    now: () => Date.now(),
  })
  return { sessions, token: await sessions.createSession(USER, []) }
}

function queryTokenRequest(token: string, allowQueryToken: boolean): FastifyRequest {
  const env = loadEnv({ NODE_ENV: "test", WS_ALLOW_QUERY_TOKEN: allowQueryToken ? "1" : "" })
  return {
    auth: { userId: null, roles: [], anon: true },
    query: { token },
    headers: {},
    cookies: {},
    server: { container: { env } },
  } as unknown as FastifyRequest
}

describe("WS_ALLOW_QUERY_TOKEN comes from the validated env", () => {
  it("defaults to off", () => {
    expect(loadEnv({ NODE_ENV: "test" }).WS_ALLOW_QUERY_TOKEN).toBe(false)
  })

  it("turns on for 1 or true", () => {
    expect(loadEnv({ NODE_ENV: "test", WS_ALLOW_QUERY_TOKEN: "1" }).WS_ALLOW_QUERY_TOKEN).toBe(true)
    expect(loadEnv({ NODE_ENV: "test", WS_ALLOW_QUERY_TOKEN: "true" }).WS_ALLOW_QUERY_TOKEN).toBe(
      true,
    )
  })

  it("accepts a ?token handshake when the env flag is on", async () => {
    const { sessions, token } = await sessionToken()

    const resolved = await resolveWsUser(queryTokenRequest(token, true), sessions)

    expect(resolved?.userId).toBe(USER)
  })

  it("ignores a process.env flag that the loaded env does not carry", async () => {
    const { sessions, token } = await sessionToken()
    process.env.WS_ALLOW_QUERY_TOKEN = "1"

    expect(await resolveWsUser(queryTokenRequest(token, false), sessions)).toBeNull()
  })
})
