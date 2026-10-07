import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import { RecordEventPageViewResponseSchema } from "@civfix/shared"
import type { Container } from "../../../src/di.js"
import { registerPageViewRoutes } from "../../../src/routes/host/page-views.routes.js"
import type { CommsRuntime } from "../../../src/services/host/comms-wiring.js"

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

async function build(recordPageView: () => Promise<{ ok: true }>): Promise<FastifyInstance> {
  const instance = Fastify()
  instance.decorate("broadcastOverrides", {
    runtime: { metrics: { recordPageView } } as unknown as CommsRuntime,
  })
  await registerPageViewRoutes(instance, {} as unknown as Container)
  await instance.ready()
  app = instance
  return instance
}

describe("POST /v1/pages/:slug/view", () => {
  it("answers with the body the endpoint registry declares", async () => {
    const instance = await build(() => Promise.resolve({ ok: true }))

    const res = await instance.inject({
      method: "POST",
      url: "/v1/pages/park-day/view",
      payload: {},
    })

    expect(res.statusCode).toBe(200)
    expect(RecordEventPageViewResponseSchema.safeParse(res.json()).success).toBe(true)
  })

  it("answers the same when the counter write fails", async () => {
    const instance = await build(() => Promise.reject(new Error("redis down")))

    const res = await instance.inject({
      method: "POST",
      url: "/v1/pages/park-day/view",
      payload: {},
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })
})
