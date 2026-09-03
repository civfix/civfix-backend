/**
 * Process entrypoint. Loads env (failing loudly on misconfiguration), starts the server, and installs the
 * process-level fault handlers.
 *
 * Node 22 terminates on an unhandled rejection, and an uncaught exception leaves the process in an
 * unknown state; either way the container must not keep serving. Both are routed through the SAME
 * graceful drain the signal handlers use (close Fastify, close the container, flush error reporting,
 * 20 s watchdog) and then exit NON-ZERO, so the supervisor restarts rather than believing the process is
 * healthy. Nothing is swallowed: the error is logged through the app logger, which carries the pino
 * redaction paths.
 */

import type { FastifyInstance } from "fastify"
import { start, makeShutdown } from "./server.js"

function installProcessFaultHandlers(app: FastifyInstance): void {
  const shutdown = makeShutdown(app, { exitCode: 1 })
  const fatal = (err: unknown, source: string): void => {
    app.log.error({ err, source }, "fatal: unhandled process error, draining")
    void shutdown(source).catch(() => process.exit(1))
  }
  process.on("unhandledRejection", (reason: unknown) => fatal(reason, "unhandledRejection"))
  process.on("uncaughtException", (err: unknown) => fatal(err, "uncaughtException"))
}

start()
  .then(installProcessFaultHandlers)
  .catch((err: unknown) => {
    console.error("fatal: failed to start civfix-api")
    console.error(err)
    process.exit(1)
  })
