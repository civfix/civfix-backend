import type { FastifyInstance } from "fastify"
import { flushErrorReporting } from "./errors/glitchtip.js"
import { SHUTDOWN_DRAIN_MS_MAX } from "./env/parsers.js"

declare module "fastify" {
  interface FastifyInstance {
    lifecycle: Lifecycle
  }
}

export const REQUEST_TIMEOUT_MS = 15_000
export const SHUTDOWN_CLOSE_WAIT_MS = REQUEST_TIMEOUT_MS
export const SHUTDOWN_TEARDOWN_WATCHDOG_MS = 15_000
export const SHUTDOWN_IDLE_SWEEP_MS = 250
export const SHUTDOWN_FORCE_GRACE_MS = 1_000
export const SHUTDOWN_BUDGET_MARGIN_MS = 5_000
export const COMPOSE_STOP_GRACE_PERIOD_SECONDS = 45

export interface Lifecycle {
  isDraining: () => boolean
  beginDrain: () => void
}

export function makeLifecycle(): Lifecycle {
  let draining = false
  return {
    isDraining: (): boolean => draining,
    beginDrain: (): void => {
      draining = true
    },
  }
}

export interface ShutdownOptions {
  drainMs: number
  closeContainer: () => Promise<void>
  closeWaitMs?: number
  teardownWatchdogMs?: number
  idleSweepMs?: number
  exit?: (code: number) => void
}

interface WebsocketHost {
  websocketServer?: { clients?: Iterable<{ terminate: () => void }> }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function settleWithin(work: Promise<unknown>, ms: number): Promise<"settled" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms)
  })
  try {
    return await Promise.race([work.then((): "settled" => "settled"), expiry])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function terminateWebsockets(app: FastifyInstance): void {
  const clients = (app as unknown as WebsocketHost).websocketServer?.clients
  if (!clients) return
  for (const client of clients) client.terminate()
}

async function closeServerBounded(
  app: FastifyInstance,
  closeWaitMs: number,
  idleSweepMs: number,
): Promise<void> {
  const closing = app.close()
  const closeIdle = (): void => {
    app.server.closeIdleConnections()
  }
  closeIdle()
  const sweep = setInterval(closeIdle, idleSweepMs)
  sweep.unref()
  try {
    const forceAfterMs = Math.max(0, closeWaitMs - SHUTDOWN_FORCE_GRACE_MS)
    if ((await settleWithin(closing, forceAfterMs)) === "settled") return
    app.log.error(
      { forceAfterMs },
      "shutdown: connections outlived the close wait; terminating websockets and destroying sockets",
    )
    terminateWebsockets(app)
    app.server.closeAllConnections()
    if ((await settleWithin(closing, SHUTDOWN_FORCE_GRACE_MS)) === "timeout") {
      app.log.error(
        { closeWaitMs },
        "shutdown: server close did not settle after forcing; proceeding to teardown",
      )
    }
  } finally {
    clearInterval(sweep)
  }
}

export function makeShutdown(
  app: FastifyInstance,
  options: ShutdownOptions,
): (signal: string) => Promise<void> {
  const closeWaitMs = options.closeWaitMs ?? SHUTDOWN_CLOSE_WAIT_MS
  const teardownWatchdogMs = options.teardownWatchdogMs ?? SHUTDOWN_TEARDOWN_WATCHDOG_MS
  const idleSweepMs = options.idleSweepMs ?? SHUTDOWN_IDLE_SWEEP_MS
  const exit = options.exit ?? ((code: number): void => process.exit(code))
  const drainMs = Math.min(SHUTDOWN_DRAIN_MS_MAX, Math.max(0, options.drainMs))
  const hardDeadlineMs = drainMs + closeWaitMs + teardownWatchdogMs
  let started = false

  if (options.drainMs > drainMs) {
    app.log.warn(
      { configured: options.drainMs, drainMs, ceiling: SHUTDOWN_DRAIN_MS_MAX },
      "shutdown: configured drain window exceeds the ceiling and was clamped",
    )
  }

  return async function shutdown(signal: string): Promise<void> {
    if (started) return
    started = true
    app.lifecycle.beginDrain()
    app.log.info(
      { signal, drainMs, closeWaitMs, teardownWatchdogMs, hardDeadlineMs },
      "shutdown: draining, /healthz now answers 503",
    )

    const deadline = setTimeout(() => {
      app.log.error({ hardDeadlineMs }, "shutdown: hard deadline exceeded; forcing exit")
      exit(1)
    }, hardDeadlineMs)
    deadline.unref()

    if (drainMs > 0) await delay(drainMs)

    app.log.info("shutdown: drain window elapsed, closing server")

    try {
      await closeServerBounded(app, closeWaitMs, idleSweepMs)
      const teardown = (async (): Promise<void> => {
        await options.closeContainer()
        await flushErrorReporting()
      })()
      if ((await settleWithin(teardown, teardownWatchdogMs)) === "timeout") {
        app.log.error({ teardownWatchdogMs }, "shutdown: teardown timed out; forcing exit")
        exit(1)
        return
      }
      app.log.info("shutdown: complete")
      exit(0)
    } catch (err) {
      app.log.error({ err }, "shutdown: error during close")
      await flushErrorReporting()
      exit(1)
    } finally {
      clearTimeout(deadline)
    }
  }
}
