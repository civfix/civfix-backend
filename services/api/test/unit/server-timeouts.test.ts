
import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { makeDb } from "../../src/db/client.js"
import { REQUEST_TIMEOUT_MS, SHUTDOWN_CLOSE_WAIT_MS } from "../../src/lifecycle.js"

let app: FastifyInstance | undefined

afterEach(async () => {
  if (app) {
    await app.close()
    app = undefined
  }
})

type WithConnection = { options: { connection?: Record<string, string> } }

describe("server timeout ordering (F029)", () => {
  it("keeps the socket timeout strictly above the request budget and the DB statement timeout", async () => {
    app = await buildServer({ env: loadEnv() })
    const socketTimeout = app.server.timeout
    const requestTimeout = app.server.requestTimeout

    expect(requestTimeout).toBeGreaterThan(0)
    expect(socketTimeout).toBeGreaterThan(requestTimeout)

    const handle = makeDb("postgres://u:p@localhost:5432/civfix")
    const statementTimeout = Number(
      (handle.sql as unknown as WithConnection).options.connection?.statement_timeout ?? "0",
    )
    expect(statementTimeout).toBeGreaterThan(0)
    expect(requestTimeout).toBeGreaterThanOrEqual(statementTimeout)
    expect(socketTimeout).toBeGreaterThan(statementTimeout)
    await handle.close()
  })

  it("never force-closes connections, and bounds the shutdown close wait by the request budget", async () => {
    app = await buildServer({ env: loadEnv() })
    // Fastify's default ('idle') calls closeAllConnections() on close, destroying sockets with a
    // request STILL IN FLIGHT - the exact dropped request the SIGTERM drain exists to prevent.
    expect(app.initialConfig.forceCloseConnections).toBe(false)
    expect(app.server.requestTimeout).toBe(REQUEST_TIMEOUT_MS)
    expect(SHUTDOWN_CLOSE_WAIT_MS).toBe(app.server.requestTimeout)
  })
})
