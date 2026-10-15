import { describe, it, expect, afterEach } from "vitest"
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import { ErrorCode } from "@civfix/shared"
import { registerRateLimit } from "../../src/plugins/rate-limit.js"
import { applyWsUpgradeRateLimit } from "../../src/routes/chat-gateway-wiring.js"

const WS_UPGRADE_CAP = 60
const CLIENT_IP = "198.51.100.9"

describe("/ws upgrade rate limit follows the matched route", () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function buildApp(): Promise<FastifyInstance> {
    const f = Fastify()
    await registerRateLimit(f)
    f.get("/ws", async () => ({ ok: true }))
    applyWsUpgradeRateLimit(f)
    await f.ready()
    return f
  }

  it("limits a percent-encoded path that the router decodes to /ws", async () => {
    app = await buildApp()
    for (let i = 0; i < WS_UPGRADE_CAP; i++) {
      const ok = await app.inject({ method: "GET", url: "/%77s", remoteAddress: CLIENT_IP })
      expect(ok.statusCode).toBe(200)
    }
    const blocked = await app.inject({ method: "GET", url: "/%77s", remoteAddress: CLIENT_IP })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json()).toMatchObject({ code: ErrorCode.RATE_LIMITED })
  })

  it("charges /ws and its encoded spellings to one bucket", async () => {
    app = await buildApp()
    const spellings = ["/ws", "/%77s", "/w%73", "/%77%73?ticket=x"]
    for (let i = 0; i < WS_UPGRADE_CAP; i++) {
      const url = spellings[i % spellings.length]!
      const ok = await app.inject({ method: "GET", url, remoteAddress: CLIENT_IP })
      expect(ok.statusCode).toBe(200)
    }
    const blocked = await app.inject({ method: "GET", url: "/ws", remoteAddress: CLIENT_IP })
    expect(blocked.statusCode).toBe(429)
  })

  it("does not charge the /ws bucket for unmatched paths", async () => {
    app = await buildApp()
    for (let i = 0; i < WS_UPGRADE_CAP; i++) {
      await app.inject({ method: "GET", url: "/ws/extra", remoteAddress: CLIENT_IP })
    }
    const ok = await app.inject({ method: "GET", url: "/ws", remoteAddress: CLIENT_IP })
    expect(ok.statusCode).toBe(200)
  })
})
