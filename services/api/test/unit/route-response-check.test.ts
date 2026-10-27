import { describe, it, expect, afterEach, vi } from "vitest"
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify"
import { expectConsoleError } from "@civfix/testing/console"
import { makeErrorHandler } from "../../src/errors/http-mapper.js"
import { registerRequestId } from "../../src/plugins/request-id.js"
import { route, type RouteOptions } from "../../src/versioning/route.js"

// openUnsubscribeBroadcasts' response is a strict `{}` whose declared input type is `unknown`, so the
// reply typing accepts any body and only the runtime check can reject one.
const URL = "/v1/broadcasts/unsubscribe"

let app: FastifyInstance | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await app?.close()
  app = undefined
})

async function serve(
  send: (reply: FastifyReply) => unknown,
  register = route,
  opts: RouteOptions = {},
) {
  app = Fastify()
  app.setErrorHandler(makeErrorHandler())
  // An app-level async onSend hook is what made a thrown drift error go out as an empty 500.
  await registerRequestId(app)
  register(app, "openUnsubscribeBroadcasts", opts, async (_request, reply) => {
    await send(reply)
  })
  await app.ready()
  return app.inject({ method: "GET", url: URL })
}

describe("route() contract response check (tests only)", () => {
  it("passes a body that matches the contract through unchanged", async () => {
    const res = await serve((reply) => reply.send({}))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({})
  })

  it("checks only the body that reaches the client, not fastify's trailing empty re-send", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const res = await serve(async (reply) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      reply.send({})
    })
    expect(res.statusCode).toBe(200)
    expect(stderr).not.toHaveBeenCalled()
  })

  it("fails a drifted success body with a 500 naming the endpoint and the issue", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const res = await serve((reply) => reply.send({ stray: 1 }))
    expect(res.statusCode).toBe(500)
    const body = res.json<{ code: string; message: string }>()
    expect(body.code).toBe("INTERNAL")
    expect(body.message).toContain("openUnsubscribeBroadcasts response does not match the contract")
    expect(body.message).toContain("stray")
    expect(stderr).toHaveBeenCalledWith(body.message)
  })

  it("fails a success reply with no JSON body, as the typed client would", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const empty = await serve((reply) => reply.status(200).send())
    expect(empty.statusCode).toBe(500)
    expect(empty.json<{ message: string }>().message).toContain("the body is empty")
    await app?.close()

    const text = await serve((reply) => reply.type("text/plain").send("ok"))
    expect(text.statusCode).toBe(500)
    expect(text.json<{ message: string }>().message).toContain("the body is not JSON")
    expect(stderr).toHaveBeenCalledTimes(2)
  })

  it("still checks when the route brings its own onSend hook", async () => {
    expectConsoleError("openUnsubscribeBroadcasts response does not match the contract")
    const ownHook = vi.fn(async (_request: unknown, _reply: unknown, payload: unknown) => payload)
    const res = await serve((reply) => reply.send({ stray: 1 }), route, { onSend: ownHook })
    expect(ownHook).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(500)
  })

  it("leaves error bodies, redirects and 204s alone", async () => {
    const notFound = await serve((reply) => reply.status(404).send({ stray: 1 }))
    expect(notFound.statusCode).toBe(404)
    await app?.close()

    const redirect = await serve((reply) => reply.status(302).send({ stray: 1 }))
    expect(redirect.statusCode).toBe(302)
    await app?.close()

    const noContent = await serve((reply) => reply.status(204).send())
    expect(noContent.statusCode).toBe(204)
  })

  it("is not registered outside the test environment", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.resetModules()
    const prodRoute = (await import("../../src/versioning/route.js")).route
    const res = await serve((reply) => reply.send({ stray: 1 }), prodRoute)
    expect(res.statusCode).toBe(200)
  })
})
