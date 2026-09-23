import { describe, expect, it } from "vitest"
import Fastify from "fastify"
import { AppError, ErrorCode } from "@civfix/shared"
import { loggerOptions } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"

const SECRET = "leak-canary-7f3a"
const SENSITIVE_KEYS = ["email", "token", "otp", "phone", "password", "accessCode"] as const

function capture(write: (log: ReturnType<typeof Fastify>["log"]) => void): string {
  const lines: string[] = []
  const app = Fastify({
    logger: {
      ...loggerOptions(loadEnv({ NODE_ENV: "test" })),
      level: "info",
      stream: {
        write(line: string) {
          lines.push(line)
        },
      },
    },
  })
  write(app.log)
  return lines.join("")
}

describe("log lines redact sensitive keys at any depth", () => {
  const shapes: ReadonlyArray<readonly [label: string, build: (key: string) => object]> = [
    ["top level", (k) => ({ [k]: SECRET })],
    ["one level down", (k) => ({ a: { [k]: SECRET } })],
    ["two levels down", (k) => ({ a: { b: { [k]: SECRET } } })],
    ["five levels down", (k) => ({ a: { b: { c: { d: { e: { [k]: SECRET } } } } } })],
    ["inside an array", (k) => ({ recipients: [{ [k]: SECRET }] })],
    ["inside a nested array", (k) => ({ batch: { rows: [[{ [k]: SECRET }]] } })],
  ]

  for (const key of SENSITIVE_KEYS) {
    it.each(shapes)(`redacts ${key} at the %s`, (_label, build) => {
      const line = capture((log) => log.info(build(key), "probe"))
      expect(line).toContain("probe")
      expect(line).not.toContain(SECRET)
    })
  }

  it("redacts inside the child logger a request handler uses", () => {
    const line = capture((log) =>
      log.child({ reqId: "r1" }).warn({ ctx: { user: { email: SECRET } } }),
    )
    expect(line).toContain('"reqId":"r1"')
    expect(line).not.toContain(SECRET)
  })

  it("redacts inside a route handler's request logger", async () => {
    const lines: string[] = []
    const app = Fastify({
      logger: {
        ...loggerOptions(loadEnv({ NODE_ENV: "test" })),
        level: "info",
        stream: {
          write(line: string) {
            lines.push(line)
          },
        },
      },
    })
    app.get("/probe", async (request) => {
      request.log.info({ ctx: { user: { email: SECRET } } }, "handler log")
      return { ok: true }
    })

    await app.inject({ method: "GET", url: "/probe" })
    await app.close()

    expect(lines.some((line) => line.includes("handler log"))).toBe(true)
    expect(lines.join("")).not.toContain(SECRET)
  })

  it("keeps non-sensitive keys and values readable", () => {
    const line = capture((log) =>
      log.info({ requestId: "req-1", code: "NOT_FOUND", statusCode: 404, nested: { count: 3 } }),
    )
    expect(JSON.parse(line)).toMatchObject({
      requestId: "req-1",
      code: "NOT_FOUND",
      statusCode: 404,
      nested: { count: 3 },
    })
  })

  it("survives a cyclic payload", () => {
    const cyclic: Record<string, unknown> = { email: SECRET, name: "loop" }
    cyclic.self = cyclic
    const line = capture((log) => log.info({ ctx: cyclic }, "cyclic"))
    expect(line).toContain("cyclic")
    expect(line).not.toContain(SECRET)
  })

  it("stops at a bounded depth instead of walking an unbounded structure", () => {
    let deep: Record<string, unknown> = { email: SECRET }
    for (let i = 0; i < 50; i++) deep = { next: deep }
    const line = capture((log) => log.info({ deep }, "deep"))
    expect(line).toContain("deep")
    expect(line).not.toContain(SECRET)
  })
})

describe("error serialization through the redaction pass", () => {
  it("keeps type, message, stack and code and redacts sensitive props inside err", () => {
    const err = Object.assign(new AppError(ErrorCode.CONFLICT, "mail failed"), {
      meta: { recipient: { email: SECRET } },
    })
    const line = capture((log) => log.error({ err }, "send failed"))
    const parsed = JSON.parse(line) as { err: Record<string, unknown> }

    expect(parsed.err.type).toBe(err.constructor.name)
    expect(parsed.err.message).toBe("mail failed")
    expect(String(parsed.err.stack)).toContain("mail failed")
    expect(parsed.err.code).toBe(ErrorCode.CONFLICT)
    expect(line).not.toContain(SECRET)
  })

  it("keeps the cause chain in the message and stack while redacting an error-valued property", () => {
    const cause = new Error("smtp down")
    const detail = Object.assign(new Error("rejected"), { email: SECRET })
    const err = Object.assign(
      new AppError(ErrorCode.INTERNAL, "Failed to send email.", { cause }),
      { detail },
    )
    const line = capture((log) => log.error({ err }, "send failed"))
    const parsed = JSON.parse(line) as { err: { message: string; stack: string; detail: object } }

    expect(parsed.err.message).toContain("smtp down")
    expect(parsed.err.stack).toContain("caused by")
    expect(parsed.err.detail).toMatchObject({ message: "rejected", email: "[REDACTED]" })
    expect(line).not.toContain(SECRET)
  })

  it("does not alter the error object the caller still holds", () => {
    const err = Object.assign(new Error("boom"), { email: SECRET })
    capture((log) => log.error({ err }, "boom"))
    expect(err.email).toBe(SECRET)
  })

  it("still strips the verbatim SMTP reply wherever it sits", () => {
    const smtp = { responseCode: 550, response: `550 <${SECRET}>: recipient unknown` }
    for (const payload of [{ smtp }, { a: { b: { smtp } } }, { list: [{ smtp }] }]) {
      const line = capture((log) => log.error(payload, "mail send failed"))
      expect(line).not.toContain(SECRET)
      expect(line).toContain('"responseCode":550')
    }
  })
})
