import type { FastifyInstance } from "fastify"
import { flushErrorReporting } from "./errors/glitchtip.js"

declare module "fastify" {
  interface FastifyInstance {
    lifecycle: Lifecycle
  }
}

export const SHUTDOWN_CLOSE_WATCHDOG_MS = 20_000

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
  closeWatchdogMs?: number
  exit?: (code: number) => void
}

export function makeShutdown(
  app: FastifyInstance,
  options: ShutdownOptions,
): (signal: string) => Promise<void> {
  const closeWatchdogMs = options.closeWatchdogMs ?? SHUTDOWN_CLOSE_WATCHDOG_MS
  const exit = options.exit ?? ((code: number): void => process.exit(code))
  const drainMs = Math.max(0, options.drainMs)
  let started = false

  return async function shutdown(signal: string): Promise<void> {
    if (started) return
    started = true
    app.lifecycle.beginDrain()
    app.log.info({ signal, drainMs }, "shutdown: draining, /healthz now answers 503")

    if (drainMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, drainMs)
      })
    }

    app.log.info("shutdown: drain window elapsed, closing server")
    const watchdog = setTimeout(() => {
      app.log.error("shutdown: close timed out; forcing exit")
      exit(1)
    }, closeWatchdogMs)
    watchdog.unref()

    try {
      await app.close()
      await options.closeContainer()
      await flushErrorReporting()
      clearTimeout(watchdog)
      app.log.info("shutdown: complete")
      exit(0)
    } catch (err) {
      clearTimeout(watchdog)
      app.log.error({ err }, "shutdown: error during close")
      exit(1)
    }
  }
}
