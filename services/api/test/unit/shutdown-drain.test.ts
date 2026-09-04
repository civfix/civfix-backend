/**
 * SIGTERM DRAIN BEHAVIOUR (blue/green deploys).
 *
 * `makeShutdown` (src/lifecycle.ts) is the whole app-side contract with the blue/green edge:
 *
 *   1. the instant the signal lands, GET /healthz answers 503 so Caddy's active health check pulls
 *      this api color out of the upstream pool on its next probe;
 *   2. the process keeps serving normally for SHUTDOWN_DRAIN_MS, so any request already in flight
 *      (and any straggler Caddy routed before it noticed) finishes instead of being destroyed by
 *      Fastify's closeAllConnections();
 *   3. only then does it close the server, then the container (pg-boss / redis / db), in that order.
 *
 * Timers are faked so the 12s drain costs nothing; the in-flight request is held open by a deferred
 * promise so the ordering assertions are exact rather than timing-dependent.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { makeShutdown } from "../../src/lifecycle.js"

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("shutdown drain", () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    vi.useRealTimers()
    if (app) {
      await app.close()
      app = undefined
    }
  })

  it("flips /healthz to 503, keeps serving for the drain window, then closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    app = await buildServer({ env: loadEnv() })
    const gate = deferred()
    app.get("/__drain-probe", async () => {
      await gate.promise
      return { served: true }
    })
    let closedAt: "before-drain" | "after-drain" | undefined
    let drainElapsed = false
    app.addHook("onClose", async () => {
      closedAt = drainElapsed ? "after-drain" : "before-drain"
    })
    await app.ready()

    const exits: number[] = []
    const shutdown = makeShutdown(app, {
      drainMs: 12_000,
      closeContainer: () => app!.container.close(),
      exit: (code) => exits.push(code),
    })

    const inFlight = app.inject({ method: "GET", url: "/__drain-probe" })
    await vi.advanceTimersByTimeAsync(0)

    expect(app.lifecycle.isDraining()).toBe(false)
    const shutdownDone = shutdown("SIGTERM")

    expect(app.lifecycle.isDraining()).toBe(true)
    const live = await app.inject({ method: "GET", url: "/healthz" })
    expect(live.statusCode).toBe(503)
    expect(live.json()).toMatchObject({ ok: false, draining: true })

    expect(closedAt).toBeUndefined()

    gate.resolve()
    const served = await inFlight
    expect(served.statusCode).toBe(200)
    expect(served.json()).toEqual({ served: true })
    expect(closedAt).toBeUndefined()

    drainElapsed = true
    await vi.advanceTimersByTimeAsync(12_000)
    await shutdownDone

    expect(closedAt).toBe("after-drain")
    expect(exits).toEqual([0])
    app = undefined
  })

  it("closes immediately when the drain window is 0, and is idempotent across repeated signals", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    app = await buildServer({ env: loadEnv() })
    let closes = 0
    app.addHook("onClose", async () => {
      closes += 1
    })
    await app.ready()

    const exits: number[] = []
    const shutdown = makeShutdown(app, {
      drainMs: 0,
      closeContainer: () => app!.container.close(),
      exit: (code) => exits.push(code),
    })

    await shutdown("SIGTERM")
    await shutdown("SIGINT")

    expect(closes).toBe(1)
    expect(exits).toEqual([0])
    app = undefined
  })

  it("a fresh server instance is not draining (the flag is per-instance, not module-global)", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({ method: "GET", url: "/healthz" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
  })
})
