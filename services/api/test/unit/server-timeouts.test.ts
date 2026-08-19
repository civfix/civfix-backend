
import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { makeDb } from "../../src/db/client.js"

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
})
