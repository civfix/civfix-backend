import { describe, it, expect, afterEach, vi } from "vitest"
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify"
import { makeErrorHandler } from "../../src/errors/http-mapper.js"
import { registerRequestId } from "../../src/plugins/request-id.js"
import { route } from "../../src/versioning/route.js"

// openUnsubscribeBroadcasts' response is a strict `{}` whose declared input type is `unknown`, so the
// reply typing accepts any body and only the runtime check can reject one.
const URL = "/v1/broadcasts/unsubscribe"

let app: FastifyInstance | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.resetModules()
  await app?.close()
  app = undefined
})

async function serve(send: (reply: FastifyReply) => unknown, register = route) {
  app = Fastify()
  app.setErrorHandler(makeErrorHandler())
  // An app-level async onSend hook is what made a thrown drift error go out as an empty 500.
  await registerRequestId(app)
  register(app, "openUnsubscribeBroadcasts", async (_request, reply) => {
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

  it("leaves error bodies and redirects alone", async () => {
    const notFound = await serve((reply) => reply.status(404).send({ stray: 1 }))
    expect(notFound.statusCode).toBe(404)
    await app?.close()

    const redirect = await serve((reply) => reply.redirect("https://civfix.dev/", 302))
    expect(redirect.statusCode).toBe(302)
  })

  it("is not registered outside the test environment", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.resetModules()
    const prodRoute = (await import("../../src/versioning/route.js")).route
    const res = await serve((reply) => reply.send({ stray: 1 }), prodRoute)
    expect(res.statusCode).toBe(200)
  })
})
