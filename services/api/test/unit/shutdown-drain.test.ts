/**
 * SIGTERM DRAIN BEHAVIOUR (blue/green deploys).
 *
 * `makeShutdown` (src/lifecycle.ts) is the whole app-side contract with the blue/green edge:
 *
 *   1. the instant the signal lands, GET /healthz answers 503 + x-civfix-draining so Caddy's active
 *      health check pulls this api color out of the upstream pool on its next probe;
 *   2. the process keeps serving normally for SHUTDOWN_DRAIN_MS;
 *   3. then it closes IDLE keep-alive sockets on a short sweep while awaiting app.close(), so parked
 *      connections cannot stretch the close while ACTIVE requests are allowed to finish (Fastify is
 *      built with forceCloseConnections:false — its default 'idle' destroys in-flight sockets too);
 *   4. only then the container (pg-boss / redis / db), under its own watchdog.
 *
 * The ordering tests fake timers so a multi-second drain costs nothing. The availability tests use a
 * REAL listener and a real keep-alive socket, because app.inject() has no socket and therefore cannot
 * observe a destroyed connection at all.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import type { FastifyInstance } from "fastify"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import {
  makeShutdown,
  REQUEST_TIMEOUT_MS,
  SHUTDOWN_CLOSE_WAIT_MS,
  SHUTDOWN_TEARDOWN_WATCHDOG_MS,
  SHUTDOWN_BUDGET_MARGIN_MS,
  SHUTDOWN_FORCE_GRACE_MS,
  COMPOSE_STOP_GRACE_PERIOD_SECONDS,
} from "../../src/lifecycle.js"
import { SHUTDOWN_DRAIN_MS_MAX } from "../../src/env/parsers.js"
import { DRAINING_HEADER } from "../../src/routes/health.routes.js"

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

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function fetchOver(
  agent: http.Agent,
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", agent }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => {
        body += chunk
      })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on("error", reject)
    req.end()
  })
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

  it("flips /healthz to 503 + the drain header, keeps serving for the drain window, then closes", async () => {
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
      drainMs: 8_000,
      closeWaitMs: SHUTDOWN_CLOSE_WAIT_MS,
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
    expect(live.json()).toEqual({ ok: false })
    expect(live.headers[DRAINING_HEADER]).toBe("1")
    expect(live.headers["cache-control"]).toBe("no-store")

    expect(closedAt).toBeUndefined()

    gate.resolve()
    const served = await inFlight
    expect(served.statusCode).toBe(200)
    expect(served.json()).toEqual({ served: true })
    expect(closedAt).toBeUndefined()

    drainElapsed = true
    await vi.advanceTimersByTimeAsync(8_000)
    await shutdownDone

    expect(closedAt).toBe("after-drain")
    expect(exits).toEqual([0])
    app = undefined
  })

  it("clamps a drain window above the loader ceiling instead of trusting it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    app = await buildServer({ env: loadEnv() })
    let closes = 0
    app.addHook("onClose", async () => {
      closes += 1
    })
    await app.ready()

    const exits: number[] = []
    const shutdown = makeShutdown(app, {
      drainMs: 10 * SHUTDOWN_DRAIN_MS_MAX,
      closeContainer: () => app!.container.close(),
      exit: (code) => exits.push(code),
    })

    const done = shutdown("SIGTERM")
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_MS_MAX)
    await done

    expect(closes).toBe(1)
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

  it("a second signal DURING the drain neither closes early nor exits twice", async () => {
    app = await buildServer({ env: loadEnv() })
    let closes = 0
    app.addHook("onClose", async () => {
      closes += 1
    })
    await app.ready()

    const exits: number[] = []
    const shutdown = makeShutdown(app, {
      drainMs: 200,
      closeContainer: () => app!.container.close(),
      exit: (code) => exits.push(code),
    })

    const first = shutdown("SIGTERM")
    await shutdown("SIGTERM")

    expect(closes).toBe(0)
    expect(exits).toEqual([])

    await first

    expect(closes).toBe(1)
    expect(exits).toEqual([0])
    app = undefined
  })

  it("a fresh server instance is not draining (the flag is per-instance, not module-global)", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({ method: "GET", url: "/healthz" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
    expect(res.headers[DRAINING_HEADER]).toBeUndefined()
    expect(res.headers["cache-control"]).toBe("no-store")
  })

  it("exits 1 when the container teardown outlives its watchdog instead of hanging", async () => {
    app = await buildServer({ env: loadEnv() })
    await app.ready()

    const exits: number[] = []
    const shutdown = makeShutdown(app, {
      drainMs: 0,
      closeContainer: () => new Promise<void>(() => {}),
      teardownWatchdogMs: 200,
      exit: (code) => exits.push(code),
    })

    await shutdown("SIGTERM")

    expect(exits).toEqual([1])
    app = undefined
  })

  it("exits 1 when the container teardown rejects", async () => {
    app = await buildServer({ env: loadEnv() })
    await app.ready()

    const exits: number[] = []
    const shutdown = makeShutdown(app, {
      drainMs: 0,
      closeContainer: () => Promise.reject(new Error("teardown boom")),
      exit: (code) => exits.push(code),
    })

    await shutdown("SIGTERM")

    expect(exits).toEqual([1])
    app = undefined
  })

  it("proceeds to teardown when the server close cannot settle, instead of waiting on it forever", async () => {
    app = await buildServer({ env: loadEnv() })
    await app.ready()
    const realClose = app.close.bind(app)
    ;(app as unknown as { close: () => Promise<void> }).close = () =>
      new Promise<void>(() => undefined)

    let teardowns = 0
    const exits: number[] = []
    const shutdown = makeShutdown(app, {
      drainMs: 0,
      closeWaitMs: SHUTDOWN_FORCE_GRACE_MS + 200,
      closeContainer: async () => {
        teardowns += 1
      },
      exit: (code) => exits.push(code),
    })

    const startedAt = Date.now()
    await shutdown("SIGTERM")
    const elapsed = Date.now() - startedAt

    expect(teardowns).toBe(1)
    expect(exits).toEqual([0])
    expect(elapsed).toBeLessThan(3 * SHUTDOWN_FORCE_GRACE_MS)
    await realClose()
    app = undefined
  })

  it("the shutdown budget fits inside the compose stop_grace_period with margin", () => {
    expect(SHUTDOWN_CLOSE_WAIT_MS).toBe(REQUEST_TIMEOUT_MS)
    expect(SHUTDOWN_FORCE_GRACE_MS).toBeLessThan(SHUTDOWN_CLOSE_WAIT_MS)
    const budget = SHUTDOWN_DRAIN_MS_MAX + SHUTDOWN_CLOSE_WAIT_MS + SHUTDOWN_TEARDOWN_WATCHDOG_MS
    expect(budget + SHUTDOWN_BUDGET_MARGIN_MS).toBeLessThanOrEqual(
      COMPOSE_STOP_GRACE_PERIOD_SECONDS * 1000,
    )
  })
})

describe("shutdown drain over a real socket", () => {
  let app: FastifyInstance | undefined
  let agent: http.Agent | undefined

  afterEach(async () => {
    agent?.destroy()
    agent = undefined
    if (app) {
      await app.close()
      app = undefined
    }
  })

  async function listen(): Promise<number> {
    await app!.listen({ port: 0, host: "127.0.0.1" })
    return (app!.server.address() as AddressInfo).port
  }

  it("an in-flight request completes across app.close() instead of dying with a socket error", async () => {
    app = await buildServer({ env: loadEnv() })
    const entered = deferred()
    app.get("/__slow", async () => {
      entered.resolve()
      await sleep(300)
      return { served: true }
    })
    const port = await listen()
    agent = new http.Agent({ keepAlive: true })

    const exits: number[] = []
    const shutdown = makeShutdown(app, {
      drainMs: 0,
      closeContainer: () => app!.container.close(),
      exit: (code) => exits.push(code),
    })

    const inFlight = fetchOver(agent, port, "/__slow")
    await entered.promise

    const done = shutdown("SIGTERM")
    const served = await inFlight

    expect(served.status).toBe(200)
    expect(JSON.parse(served.body)).toEqual({ served: true })

    await done
    expect(exits).toEqual([0])
    app = undefined
  })

  it("a parked keep-alive connection does not stretch the close", async () => {
    app = await buildServer({ env: loadEnv() })
    const port = await listen()
    agent = new http.Agent({ keepAlive: true })

    const warm = await fetchOver(agent, port, "/healthz")
    expect(warm.status).toBe(200)

    const exits: number[] = []
    const shutdown = makeShutdown(app, {
      drainMs: 0,
      closeContainer: () => app!.container.close(),
      exit: (code) => exits.push(code),
    })

    const startedAt = Date.now()
    await shutdown("SIGTERM")
    const elapsed = Date.now() - startedAt

    expect(exits).toEqual([0])
    expect(elapsed).toBeLessThan(1_000)
    app = undefined
  })
})
