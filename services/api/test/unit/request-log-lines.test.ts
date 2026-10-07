import { get as httpGet } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance, LogLevel } from "fastify"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"

interface LogLine {
  level: number
  msg: string
  reqId?: string
  req?: { method: string; url: string; host: string; remoteAddress: string }
  res?: { statusCode: number }
  responseTime?: number
}

const INFO = 30
const DEBUG = 20

describe("request log lines", () => {
  let app: FastifyInstance | undefined
  let lines: LogLine[]

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function serve(level: LogLevel): Promise<FastifyInstance> {
    lines = []
    app = await buildServer({
      env: loadEnv(),
      logCapture: { level, stream: { write: (line) => lines.push(JSON.parse(line) as LogLine) } },
    })
    app.get("/__log-probe", async () => ({ ok: true }))
    app.get("/__log-slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      return { ok: true }
    })
    await app.ready()
    return app
  }

  const requestLines = () => lines.filter((line) => line.req !== undefined || line.res !== undefined)

  async function untilRequestLine(): Promise<void> {
    await expect.poll(() => requestLines().length, { timeout: 2000 }).toBeGreaterThan(0)
  }

  it("writes nothing for a passing /healthz or /readyz probe", async () => {
    const server = await serve("info")
    expect((await server.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200)
    expect((await server.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200)
    expect(requestLines()).toEqual([])
  })

  it("still logs a failing probe", async () => {
    const server = await serve("info")
    server.lifecycle.beginDrain()
    expect((await server.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(503)
    expect(requestLines()).toMatchObject([
      { level: INFO, msg: "request completed", req: { url: "/healthz" }, res: { statusCode: 503 } },
    ])
  })

  it("writes one info line per request, on completion, with the query string dropped", async () => {
    const server = await serve("info")
    const res = await server.inject({
      method: "GET",
      url: "/__log-probe?accessCode=SUMMER2026",
      headers: { "x-request-id": "log-line-1" },
    })
    expect(res.statusCode).toBe(200)

    const written = requestLines()
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      level: INFO,
      msg: "request completed",
      reqId: "log-line-1",
      req: { method: "GET", url: "/__log-probe" },
      res: { statusCode: 200 },
    })
    expect(typeof written[0]?.responseTime).toBe("number")
    expect(JSON.stringify(lines)).not.toContain("SUMMER2026")
  })

  it("keeps the incoming line at debug for local runs", async () => {
    const server = await serve("debug")
    await server.inject({ method: "GET", url: "/__log-probe" })
    expect(requestLines().map((line) => [line.level, line.msg])).toEqual([
      [DEBUG, "incoming request"],
      [INFO, "request completed"],
    ])
  })

  it("still writes a line for a WebSocket upgrade, which never completes", async () => {
    const server = await serve("info")
    const port = await listen(server)
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=SECRET-TICKET`)
    await new Promise((resolve) => socket.addEventListener("close", resolve))
    await untilRequestLine()

    expect(requestLines()).toMatchObject([
      { level: INFO, msg: "incoming request", req: { method: "GET", url: "/ws", remoteAddress: "127.0.0.1" } },
    ])
    expect(typeof requestLines()[0]?.reqId).toBe("string")
    expect(JSON.stringify(lines)).not.toContain("SECRET-TICKET")
  })

  it("still writes a line for a request the client abandons", async () => {
    const server = await serve("info")
    const port = await listen(server)
    const abandoned = httpGet(`http://127.0.0.1:${port}/__log-slow?accessCode=SUMMER2026`)
    const hungUp = new Promise((resolve) => abandoned.once("error", resolve))
    setTimeout(() => abandoned.destroy(), 100)
    await hungUp
    await untilRequestLine()
    // The handler still finishes after the abort; it must not add a completed line.
    await new Promise((resolve) => setTimeout(resolve, 600))

    const written = requestLines()
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      level: INFO,
      msg: "request aborted",
      req: { method: "GET", url: "/__log-slow", remoteAddress: "127.0.0.1" },
    })
    expect(typeof written[0]?.reqId).toBe("string")
    expect(typeof written[0]?.responseTime).toBe("number")
    expect(JSON.stringify(lines)).not.toContain("SUMMER2026")
  })
})

async function listen(server: FastifyInstance): Promise<number> {
  await server.listen({ host: "127.0.0.1", port: 0 })
  const address = server.server.address()
  if (address === null || typeof address === "string") throw new Error("server has no TCP address")
  return address.port
}
