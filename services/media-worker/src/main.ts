/**
 * Media worker process entrypoint, plus the process-level fault handlers.
 *
 * An unhandled rejection or uncaught exception leaves the worker in an unknown state; both are routed
 * through the SAME graceful stop the signal handlers use and then exit NON-ZERO so the supervisor
 * restarts instead of leaving a half-dead consumer attached to the queue. Nothing is swallowed.
 */

import { start, makeShutdown, type Worker } from "./worker.js"

function installProcessFaultHandlers(worker: Worker): void {
  const shutdown = makeShutdown(worker, { exitCode: 1 })
  const fatal = (err: unknown, source: string): void => {
    console.error(`media-worker: fatal ${source}`, err)
    void shutdown(source).catch(() => process.exit(1))
  }
  process.on("unhandledRejection", (reason: unknown) => fatal(reason, "unhandledRejection"))
  process.on("uncaughtException", (err: unknown) => fatal(err, "uncaughtException"))
}

start()
  .then(installProcessFaultHandlers)
  .catch((err: unknown) => {
    console.error("fatal: failed to start civfix media-worker")
    console.error(err)
    process.exit(1)
  })
