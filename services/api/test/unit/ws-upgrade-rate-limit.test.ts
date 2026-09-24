import { describe, it, expect, afterEach } from "vitest"
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import { ErrorCode } from "@civfix/shared"
import { registerRateLimit } from "../../src/plugins/rate-limit.js"
import { applyWsUpgradeRateLimit } from "../../src/routes/chat-gateway-wiring.js"

/**
 * Regression (prod chat outage): the /ws upgrade limiter must ALLOW connections under the per-IP cap and
 * only 429 once it is exceeded. @fastify/rate-limit's createRateLimit result uses `isAllowed` to mean
 * "allowlist-EXEMPT" (hardcoded false on the normal path); the over-limit verdict is `isExceeded`. The
 * earlier `if (!result.isAllowed)` check 429'd EVERY upgrade, so chat could never connect for anyone.
 *
 * CI missed it because the offline test boot skips the rate-limit plugin (createRateLimit is then absent
 * and the limiter no-ops), so this test registers the real plugin to exercise the actual result handling.
 */
describe("/ws upgrade rate limit", () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function buildApp(): Promise<FastifyInstance> {
    const f = Fastify()
    await registerRateLimit(f) // in-memory store; global ceiling 300/min
    f.get("/ws", async () => ({ ok: true })) // stand-in for the real upgrade route
    applyWsUpgradeRateLimit(f)
    await f.ready()
    return f
  }

  it("allows the FIRST /ws upgrade (does not 429 every request)", async () => {
    app = await buildApp()
    const res = await app.inject({ method: "GET", url: "/ws" })
    expect(res.statusCode).toBe(200)
  })

  it("429s only after the per-IP cap (60/min) is exceeded", async () => {
    app = await buildApp()
    for (let i = 0; i < 60; i++) {
      const ok = await app.inject({ method: "GET", url: "/ws" })
      expect(ok.statusCode).toBe(200)
    }
    const blocked = await app.inject({ method: "GET", url: "/ws" })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json()).toMatchObject({ code: ErrorCode.RATE_LIMITED })
    expect(blocked.headers["retry-after"]).toBeDefined()
    expect(blocked.headers["x-ratelimit-limit"]).toBe("60")
    expect(blocked.headers["x-ratelimit-remaining"]).toBe("0")
    expect(blocked.headers["x-ratelimit-reset"]).toBeDefined()
  })

  it("keys the upgrade bucket per IP under its own namespace", async () => {
    app = await buildApp()
    const blocked = async (ip: string) => {
      for (let i = 0; i < 60; i++)
        await app!.inject({ method: "GET", url: "/ws", remoteAddress: ip })
      return app!.inject({ method: "GET", url: "/ws", remoteAddress: ip })
    }
    expect((await blocked("203.0.113.9")).statusCode).toBe(429)
    const other = await app.inject({ method: "GET", url: "/ws", remoteAddress: "198.51.100.4" })
    expect(other.statusCode).toBe(200)
  })
})
