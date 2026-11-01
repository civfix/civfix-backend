import { describe, it, expect, vi, afterEach } from "vitest"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { expectConsoleError } from "@civfix/testing/console"
import { contractResponseCheck } from "../../src/versioning/response-check.js"

// openUnsubscribeBroadcasts' response is a strict `{}`, so any extra key is drift.
const NAME = "openUnsubscribeBroadcasts"
const REQUEST_ID = "req-response-check"

class FakeReply {
  readonly headers: Record<string, string> = {}
  constructor(public statusCode: number) {}
  code(statusCode: number): this {
    this.statusCode = statusCode
    return this
  }
  type(contentType: string): this {
    this.headers["content-type"] = contentType
    return this
  }
}

function onSend(reply: FakeReply, payload: unknown): Promise<unknown> {
  const hook = contractResponseCheck(NAME)
  return hook.call(
    {} as FastifyInstance,
    { id: REQUEST_ID } as FastifyRequest,
    reply as unknown as FastifyReply,
    payload,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("contractResponseCheck", () => {
  it("T11: passes a body that matches the contract through unchanged", async () => {
    const stderr = vi.spyOn(console, "error")
    const reply = new FakeReply(200)
    const payload = JSON.stringify({})
    await expect(onSend(reply, payload)).resolves.toBe(payload)
    expect(reply.statusCode).toBe(200)
    expect(stderr).not.toHaveBeenCalled()
  })

  it("T12: rewrites a drifted body to a 500 naming the endpoint and the drift", async () => {
    const message = `${NAME} response does not match the contract: (root): Unrecognized key: "stray"`
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const reply = new FakeReply(200)
    const result = await onSend(reply, JSON.stringify({ stray: 1 }))
    expect(result).toBe(JSON.stringify({ code: "INTERNAL", message, requestId: REQUEST_ID }))
    expect(reply.statusCode).toBe(500)
    expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8")
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(stderr).toHaveBeenCalledWith(message)
  })

  it("T13: checks a second payload on the same reply too", async () => {
    const message = `${NAME} response does not match the contract: the body is empty`
    expectConsoleError(message)
    const reply = new FakeReply(200)
    const payload = JSON.stringify({})
    await expect(onSend(reply, payload)).resolves.toBe(payload)
    const second = await onSend(reply, undefined)
    expect(second).toBe(JSON.stringify({ code: "INTERNAL", message, requestId: REQUEST_ID }))
    expect(reply.statusCode).toBe(500)
  })
})
