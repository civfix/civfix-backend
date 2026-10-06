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
    await app.ready()
    return app
  }

  const requestLines = () => lines.filter((line) => line.req !== undefined || line.res !== undefined)

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
})
